# Despliegue de TestCraft Evals en Endava

## Estado y alcance

La preparación reproducible y el procedimiento de retirada para el taller están en [AWS workshop runbook](aws-workshop-runbook.md). La plantilla recibe un secreto creado por el operador y conserva el volumen de datos al borrar el stack: ambos necesitan retirada explícita para evitar cargos residuales.

El proyecto incluye una imagen Docker, lectura de Secrets Manager, controles de reinicio, tests y un workflow de GitHub Actions. **Eso no significa que esté online:** todavía hay que aprobar/provisionar la infraestructura, configurar los permisos/variables y ejecutar el primer despliegue.

Esta guía mantiene la arquitectura actual: un proceso Node con SQLite y siete participantes con sesiones anónimas. No agrega cuentas de usuario, réplicas, PostgreSQL ni cambios al evaluador. El enlace público no exige login; cualquiera que lo obtenga puede entrar y consumir el cupo compartido. El cupo de llamadas no es un límite monetario.

El acceso humano usa el perfil SSO `endava`; no cambiar ni reutilizar `default`, que pertenece a otra organización. `eu-central-1` es la región del SSO, mientras que `us-east-1` es la región de trabajo acordada. El pipeline no usa una sesión SSO personal.

## 1. Aprobar la red y el costo antes de crear recursos

En la cuenta revisada hay una subred privada de la VPC Default sin ruta de salida a Internet. No sirve tal cual para llamar TestCraft, Secrets Manager, ECR y los LLM. Las redes privadas con salida pertenecen a otros proyectos; su existencia no autoriza reutilizarlas.

Opciones a resolver con Endava: una subred privada aprobada con salida ya disponible, o una red exclusiva de este proyecto. No modificar rutas ni grupos de seguridad compartidos para habilitar la app sin autorización. Si se crea una salida NAT exclusiva, tiene costo por hora y datos incluso sin asistentes conectados. Revisar una estimación en AWS Pricing Calculator y configurar alertas de presupuesto; las alertas no cortan automáticamente el gasto.

Como referencia, el catálogo de AWS consultado el 8 de septiembre de 2026 indica USD 0,0208/h para `t3.small` Linux y USD 0,045/h para un NAT Gateway en `us-east-1`: alrededor de USD 15,18 y USD 32,85 por 730 horas. Sumando IPv4 de la salida NAT, discos y almacenamiento pequeño, reservar aproximadamente **USD 55–65 por mes** para una instalación exclusiva encendida todo el mes, antes de modelos, tráfico, impuestos y consumos adicionales. Es una estimación, no un tope ni una cotización corporativa; verificar descuentos y créditos con Endava. [EC2 On-Demand](https://aws.amazon.com/ec2/pricing/on-demand/), [VPC e IPv4](https://aws.amazon.com/vpc/pricing/), [EBS](https://aws.amazon.com/ebs/pricing/).

La opción prevista es EC2 privada con CloudFront VPC origin. La VPC debe tener internet gateway, una subred privada con IPv4 disponible, DNS y salida HTTPS. En `us-east-1`, evitar la zona cuyo ID físico es `use1-az3`; la letra visible de la zona no basta para identificarla. No crear un balanceador ni NAT redundante solo para este taller. [Requisitos de CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html), [costos de red](https://aws.amazon.com/vpc/pricing/).

## 2. Crear los recursos exclusivos de la app

Una vez aprobada la red, crear y etiquetar los recursos con proyecto, responsable y centro de costo requeridos por Endava:

- **ECR privado:** repositorio `testcraft-evals`, escaneo de imágenes y tags inmutables. Cada ejecución publica un tag diferente y despliega por digest, nunca por `latest`. No borrar imágenes vigentes ni la versión anterior en las políticas de retención.
- **S3 privado:** bucket de artefactos con bloqueo de acceso público, cifrado, versionado y política que rechace HTTP. El prefijo `releases/` contiene únicamente scripts y configuración no secreta, no SQLite ni claves. Limitar quién puede escribir allí: sus scripts se ejecutan con permisos de administrador en la instancia.
- **Secrets Manager:** un secreto JSON, creado desde la consola, con `OPENAI_API_KEY` y opcionalmente `TESTCRAFT_OPENAI_API_KEY`. Son credenciales distintas: la segunda se envía explícitamente a TestCraft; la primera solamente al proveedor del grader. No poner URLs ni instrucciones en el secreto. No enviarlo por chat. El arranque solo verifica acceso/formato del secreto, no saldo ni compatibilidad real del modelo. [SDK oficial](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-javascript.html).
- **EC2:** Amazon Linux 2023 x86_64, inicialmente `t3.small`, una sola instancia sin IP pública. No usar Spot para el taller. Disco raíz cifrado de al menos 16 GiB y volumen de datos gp3 cifrado separado de 20 GiB, en la misma zona. Conservar el volumen de datos al terminar/reemplazar la instancia. Revisar permisos corporativos y la capacidad antes de confirmar la compra.
- **Volumen de datos:** identificar y montar exclusivamente el nuevo volumen en `/var/lib/testcraft-evals`, con montaje persistente por UUID. Nunca formatear por suposición un dispositivo `/dev/nvme…`: comprobar ID de volumen y ausencia de filesystem. El deploy se niega a funcionar si esa ruta no es un punto de montaje. Dentro se crearán `data/` (UID/GID 1000, permisos 700) y `backups/` (root, 700).
- **Administración:** Systems Manager, sin abrir SSH. Instalar Docker, AWS CLI v2 y `jq`; habilitar Docker al arrancar. El agente SSM debe aparecer Online antes de continuar. Usar IMDSv2 obligatorio y hop limit 2 para que el contenedor pueda obtener el rol de la instancia. No alojar contenedores ajenos en esa instancia. [Opciones de metadata](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html).

El rol de EC2 debe poder usar SSM (`AmazonSSMManagedInstanceCore`), descargar las imágenes de **ese** repositorio ECR, leer `releases/*` de **ese** bucket y hacer `secretsmanager:GetSecretValue` de **ese** secreto. `ecr:GetAuthorizationToken` requiere recurso `*`; las operaciones de descarga se limitan al ARN del repositorio. Agregar `kms:Decrypt` de la clave concreta solo si se usa cifrado KMS personalizado. No asignar AdministratorAccess al servidor.

## 3. Publicar HTTPS sin comprar dominio

Crear un grupo de seguridad propio que admita TCP 3000 únicamente desde la lista administrada de orígenes CloudFront. No abrir 22 ni 3000 a `0.0.0.0/0`. La lista de CloudFront consume una parte importante de la cuota de reglas; si no cabe, revisar la cuota, no ampliar el acceso. Permitir salida HTTPS a los proveedores/servicios aprobados.

En CloudFront:

1. Crear un **VPC origin** apuntando al ARN de esta EC2, puerto HTTP 3000. Esperar a que termine de desplegarse.
2. Crear la distribución usando ese origen y el DNS privado de EC2. Usar el certificado predeterminado para el hostname `…cloudfront.net`.
3. Redirigir HTTP a HTTPS y permitir GET, HEAD, OPTIONS, PUT, PATCH, POST y DELETE.
4. Elegir **CachingDisabled** y una política de solicitud de origen **AllViewer** que reenvíe cookies, `Origin`, `X-CSRF-Token` y query strings. Aplicarlo a toda la app; no cachear respuestas privadas.
5. Configurar el TTL de caché de errores 500/502/503/504 en 0. No devolver `index.html` con 200 ante errores de API.
6. Copiar el origen exacto `https://…cloudfront.net`, sin slash final, como `APP_ORIGIN`. No usar una IP privada ni el hostname local del contenedor.

Después puede limitarse el ingreso del servidor al grupo creado por CloudFront para esta cuenta; no editar el grupo administrado por AWS. La distribución no responderá correctamente hasta instalar la app. [VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html), [políticas de caché](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html), [reenvío al origen](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).

## 4. Dar a GitHub acceso temporal, limitado a este proyecto

Revisar si la cuenta ya tiene un proveedor OIDC para `https://token.actions.githubusercontent.com`; reutilizarlo si está aprobado, sin alterar configuraciones compartidas. Si falta, crearlo con audiencia `sts.amazonaws.com`.

Crear un rol de despliegue cuya confianza permita `sts:AssumeRoleWithWebIdentity` exclusivamente con:

```json
{
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:TestCraft-App/evals-framework:ref:refs/heads/main"
  }
}
```

Esas son las condiciones, no una política de confianza completa: también hacen falta el Principal Federated del proveedor y la acción indicada. No usar `repo:*`, permitir forks ni dar credenciales al job de PR. Este workflow no usa un GitHub Environment: agregar uno cambia el `sub` y requiere actualizar/restringir la confianza correspondientemente. [Guía OIDC de GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

Permisos del rol de despliegue:

| Acciones | Recursos |
| --- | --- |
| `ecr:GetAuthorizationToken` | `*` (el servicio lo requiere) |
| `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:DescribeImages` | Solo el repositorio ECR de la app |
| `s3:PutObject` | Solo `arn:aws:s3:::BUCKET/releases/*` |
| `ssm:SendCommand` | Solo el ARN de esta instancia y `arn:aws:ssm:us-east-1::document/AWS-RunShellScript` |
| `ssm:GetCommandInvocation` | `*` (sin recurso individual compatible) |

No necesita leer el secreto desde GitHub, administrar redes, crear instancias ni permisos de administrador sobre la cuenta. Aun así, quien despliega código o ejecuta Run Command controla el servidor y potencialmente sus datos: proteger el repositorio, revisar PRs y restringir acceso al rol.

## 5. Configurar las variables y activar el primer despliegue

En GitHub → Settings → Secrets and variables → Actions → Variables, cargar:

| Variable | Valor |
| --- | --- |
| `AWS_ACCOUNT_ID` | ID verificado de la cuenta Endava |
| `AWS_REGION` | `us-east-1` |
| `AWS_ROLE_ARN` | ARN del rol OIDC de despliegue, no el rol SSO personal |
| `AWS_INSTANCE_ID` | ID de la EC2 exclusiva de la app |
| `AWS_ARTIFACT_BUCKET` | Nombre del bucket privado de releases |
| `ECR_REPOSITORY_URI` | URI del repositorio ECR sin tag |
| `AWS_SECRET_ARN` | ARN del secreto; no su contenido |
| `APP_ORIGIN` | Origen HTTPS exacto de CloudFront |
| `WORKSHOP_ID` | `workshop`, estable durante las actualizaciones |
| `WORKSHOP_MAX_MODEL_CALLS` | `200` inicialmente; `0` permite solo pruebas locales sin llamadas |
| `AWS_DEPLOY_ENABLED` | Mantener ausente/`false` hasta completar todos los pasos; después `true` |

Subir estos cambios mediante un PR, exigir el job `test` en la protección de `main`, bloquear pushes directos y revisar los cambios del workflow. Un push a `main` también activa el workflow; la regla de protección es lo que obliga a pasar por un PR.

Con la infraestructura lista y `AWS_DEPLOY_ENABLED=true`, ejecutar **Actions → Test and deploy → Run workflow → main** para el primer despliegue. Luego cada merge a `main` ejecutará tests y deploy automáticamente. Ningún paso usa `default`, instala tu clave SSH personal o persiste claves AWS permanentes.

## 6. Qué hace cada actualización

Los tests de backend y navegador usan datos temporales y proveedores simulados. El workflow construye y prueba una imagen sin claves, y solo si todo pasa publica la versión para AWS. El job de deploy verifica cuenta, región, repositorio y commit antes de publicar; la instancia descarga una imagen fijada por digest mediante SSM, sin SSH ni checkout de GitHub en el servidor.

Se comprueban los hashes del script y del manifiesto descargados. Un bloqueo impide despliegues concurrentes. El nuevo contenedor se prueba primero con una base temporal: valida arranque y lectura del secreto sin tocar los datos del taller ni llamar un LLM.

Después la app deja de aceptar nuevas runs, pero termina las aceptadas. Si no queda libre en diez minutos, se cancela el deploy y se reabre la admisión. Cuando termina, se detiene el contenedor, se guarda un backup consistente de `data/`, se inicia el nuevo y se comprueba `/healthz`. Si falla, se intenta volver al contenedor anterior **sin restaurar la base**, para no perder datos ni devolver llamadas consumidas. La persona operadora debe verificar cualquier rollback fallido. Las migraciones futuras deben ser compatibles con la versión anterior.

Hay una breve interrupción al cambiar el único servidor. El workflow no cancela un deploy activo para empezar otro. Una invocación SSM con resultado desconocido no se reenvía automáticamente; revisar su ID antes de reintentar. Una caída brusca/reinicio forzado marca las runs incompletas como Interrupted al arrancar, sin repetirlas ni inventar resultados.

## 7. Ensayo obligatorio antes del taller

1. Abrir el enlace HTTPS en dos perfiles de navegador: guardar casos diferentes y verificar que no se vean entre sí.
2. Probar Load example → guardar → ejecutar → borrar run, sin créditos LLM.
3. Configurar límites del proveedor y ejecutar una generación real TestCraft y una evaluación real con model grader, con entrada sintética de SauceDemo. Esta prueba sí consume llamadas/créditos; un catálogo de modelos disponible no la reemplaza.
4. Mantener una run en curso durante un deploy controlado; comprobar que termina, que sobreviven las sesiones/datos y que no se repiten llamadas.
5. Verificar desde fuera de AWS que solo se puede entrar por HTTPS de CloudFront, no por el puerto del servidor, y que las respuestas de API no se cachean entre navegadores.
6. Configurar monitoreo de salud, disco y costos. Probar reinicio de la instancia, acceso SSM y recuperación en un volumen nuevo.

El backup previo al deploy en el mismo EBS no protege contra pérdida del volumen. Configurar AWS Backup/snapshots cifrados con retención y probar restauración antes del curso. Vigilar/definir retención de backups e imágenes; los scripts no borran automáticamente respaldos ni datos de participantes. Los snapshots, imágenes, discos, secretos y NAT pueden seguir cobrando aunque la EC2 esté detenida. Preparar el apagado/eliminación de recursos exclusivos cuando termine el uso, con autorización y conservación de los datos necesarios.

Quedan fuera de este primer despliegue: criterios híbridos, Pass/Fail ponderado, suites/carpetas, edición/duplicación/borrado de evaluaciones, entornos TestCraft y modificaciones al prompt de Dev. Se mantienen como la siguiente etapa, no como funcionalidades ya implementadas.
