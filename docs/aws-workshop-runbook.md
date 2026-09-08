# Operación del workshop en AWS

## Destino y preparación

- Cuenta Endava: `419466290453`, perfil `endava`, región `us-east-1`.
- Stack exclusivo: `testcraft-evals-workshop`.
- Retirada prevista: jueves 10 de septiembre de 2026 a las 19:00 de Uruguay. Un recordatorio no apaga ni borra recursos.
- El perfil AWS `default` y la cuenta GitHub `juan-fagundez_cldev` pertenecen a otro contexto; no usarlos.
- Presupuesto orientativo para 48 horas: USD 4–6 de AWS, más modelos, impuestos y consumos adicionales. No es un límite de gasto. La hora real de retirada importa.

El 8 de septiembre se verificó que la cuota de redes estaba llena (5 de 5). AWS **aprobó y aplicó** la ampliación a 6 mediante Service Quotas, solicitud `01e70684f5604ff8936d147ed9435069CrrGGtaM`. La solicitud no creó redes ni servidores. El script vuelve a comprobar espacio libre antes de provisionar, porque otra aplicación podría consumirlo. No reutilizar redes ajenas para sortear una cuota llena.

## Claves: las carga el operador, no el repositorio

1. Entrar a la consola AWS de **Endava** y seleccionar **N. Virginia (`us-east-1`)**.
2. Abrir **Secrets Manager → Store a new secret → Other type of secret**.
3. En **Key/value pairs**, agregar `OPENAI_API_KEY` con la clave del model grader. Agregar `TESTCRAFT_OPENAI_API_KEY` solo si se quiere enviar explícitamente esa clave al backend de TestCraft para generar contenido.
4. Usar el cifrado predeterminado de Secrets Manager, salvo que Endava requiera otro. Una clave KMS personalizada necesita permisos adicionales específicos.
5. Elegir un nombre exclusivo de la app. Para este despliegue el operador creó **`evals-app`** y confirmó el ARN `arn:aws:secretsmanager:us-east-1:419466290453:secret:evals-app-S8XRid`. No crear un duplicado ni renombrarlo. La etiqueta `Project=testcraft-evals` puede ayudar a identificarlo durante la retirada.
6. No habilitar rotación automática sin una integración que realmente rote esas claves. Guardar.
7. Compartir solamente el **ARN**, nunca el valor del secreto. CloudFormation, GitHub y los scripts reciben el ARN; la app obtiene las claves en memoria usando su rol limitado.

La existencia del secreto no verifica saldo, acceso al modelo ni que la generación de TestCraft funcione. Eso requiere un ensayo real después del despliegue. El secreto es externo al stack: **borrar el stack no lo elimina**.

## Provisionar y publicar

`scripts/aws/infrastructure.mjs` genera la plantilla reproducible. `scripts/aws/provision.ps1` valida identidad, coincidencia exacta con el ARN del secreto proporcionado (sin leer su valor), zona compatible, cuota VPC/IPv4, lista de CloudFront, OIDC y ausencia de otro stack con el mismo nombre. El nombre del secreto es libre; la cuenta, región y ARN deben coincidir. Por defecto solo comprueba; `-Create` solicita la creación de recursos de pago.

Desde PowerShell en la carpeta del proyecto, con el ARN real:

```powershell
./scripts/aws/provision.ps1 -RuntimeSecretArn 'ARN_DEL_SECRETO'
./scripts/aws/provision.ps1 -RuntimeSecretArn 'ARN_DEL_SECRETO' -Create
```

La plantilla crea una VPC exclusiva, una subred pública para NAT, una privada para EC2, una sola NAT/IPv4, `t3.small` con CPU credits Standard (sin recargos Unlimited), 16 GiB raíz y 20 GiB de datos cifrados, ECR, S3 privado, roles limitados, VPC origin y CloudFront sin caché. No crea ALB, RDS, WAF, dominio, plan mensual de CloudFront ni claves AWS permanentes. El rol OIDC existente se referencia sin modificar el proveedor compartido.

CloudFormation `CREATE_COMPLETE` no significa que la app ya esté instalada. Comprobar que la instancia aparece Online en Systems Manager y que el volumen correcto está montado. El bootstrap identifica el volumen por su ID de AWS, no por su posición; rechaza discos montados, particionados o con un formato inesperado.

En GitHub, iniciar sesión como **jfagundez-uy** para configurar Actions. Tener SSH funcionando no autoriza la API de administración. Se puede usar `gh auth login --hostname github.com --web --git-protocol ssh --skip-ssh-key` y verificar la cuenta después, sin agregar otra clave SSH ni usar la cuenta de ClassLink.

Configurar las variables de Actions con los Outputs del stack según [la guía de despliegue](aws-deployment.md). Mantener `AWS_DEPLOY_ENABLED=false` hasta que la infraestructura y el secreto estén preparados. Subir los cambios mediante PR; verificar tests, mergear y activar el primer release. El pipeline no crea infraestructura: actualiza solo esta app con una imagen inmutable y guarda los datos en el mismo volumen.

Registrar el StackId, AppOrigin, InstanceId, DataVolumeId, ArtifactBucket, EcrRepositoryUri, SecretArn, DistributionId, NatGatewayId y NatAllocationId para la retirada. No registrar valores de secretos.

## Retirada completa: requiere revisar y confirmar los objetivos

No ejecutar una eliminación con un nombre supuesto ni usar comandos sobre toda la cuenta. Leer Outputs y recursos del stack exacto, comprobar etiquetas, cuenta y región. **Esta operación quita la app de Internet y puede destruir evaluaciones, runs, backups e imágenes.** Confirmar si se necesita exportar algo antes de borrar. Los recursos de otros proyectos y el proveedor OIDC compartido quedan fuera.

1. Poner `AWS_DEPLOY_ENABLED=false` en el repositorio correcto y comprobar que no hay un despliegue en curso.
2. Pausar nuevas runs y esperar a que terminen las aceptadas. Si se pidió una exportación, realizarla por un canal privado antes de continuar.
3. Guardar el inventario de identificadores no secretos. Revisar si hay snapshots o volúmenes retenidos de reemplazos/rollbacks pertenecientes **a esta app**.
4. Vaciar **solo** el bucket de artefactos identificado, incluidas versiones, delete markers y cargas multipart pendientes. Un bucket versionado con objetos no permite que CloudFormation lo elimine.
5. Eliminar el stack exacto y seguir sus eventos hasta `DELETE_COMPLETE`. CloudFormation retira la distribución/VPC origin, instancia y disco raíz, NAT y su Elastic IP, ECR con sus imágenes, bucket vacío y red/roles exclusivos. Un error de eliminación significa que algunos cargos pueden continuar: resolver el recurso concreto y verificar de nuevo.
6. El volumen de datos tiene `DeletionPolicy: Retain` para evitar pérdida por reemplazos: **eliminarlo expresamente por el DataVolumeId verificado** cuando esté desligado de la instancia. Revisar también los volúmenes retenidos de intentos fallidos. Este paso borra SQLite y los backups locales; no es recuperable sin una copia externa.
7. Eliminar el secreto externo exclusivo identificado por el **SecretArn del inventario** (`evals-app` para esta instalación) desde Secrets Manager con el período de recuperación acordado. Verificar que no se haya reutilizado en otra app. Borrar un secreto almacenado **no revoca** las claves en el proveedor; si eran exclusivas del taller, coordinar su revocación. No revocar claves compartidas por otras aplicaciones.
8. Eliminar únicamente los snapshots/backups adicionales de este proyecto que el usuario haya confirmado retirar. No conservar recursos de pago y afirmar que el costo llegó a cero.
9. Consultar nuevamente EC2, EBS/snapshots, NAT/Elastic IP, S3, ECR, Secrets Manager y CloudFront usando los IDs/etiquetas inventariados. Informar cualquier residuo y su estado; Billing puede mostrar cargos ya devengados con retraso.

No hay borrado desatendido autorizado por el control de seguridad. Un recordatorio de Codex depende de que el entorno local pueda ejecutarlo y no garantiza la retirada. Si SSO venció, renovar `aws sso login --profile endava`. Si la app aún no llegó a desplegarse, comprobar de todos modos si hay un secreto manual, un stack parcial o discos retenidos antes de concluir que no queda nada.
