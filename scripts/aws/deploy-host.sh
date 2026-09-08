#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $EUID == 0 ]] || { echo 'Run this through Systems Manager as root.' >&2; exit 1; }
for tool in aws docker jq flock mountpoint tar; do command -v "$tool" >/dev/null; done
exec 9>/run/lock/testcraft-evals-deploy.lock
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
mountpoint -q /var/lib/testcraft-evals || { echo 'The dedicated persistent volume is not mounted. Deployment refused.' >&2; exit 1; }
manifest=${1:?Release manifest required}
jq -e 'type == "object" and
  (.account | test("^[0-9]{12}$")) and
  (.region | test("^[a-z]{2}-[a-z]+-[0-9]$")) and
  (.release | test("^[a-f0-9]{40}$")) and
  (.workshop | test("^[A-Za-z0-9_-]{1,80}$")) and
  (.origin | test("^https://[a-zA-Z0-9.-]+$")) and
  (.allowance | type == "number" and . >= 0 and . <= 100000 and . == floor) and
  (.secretArn | type == "string") and (.image | type == "string")' "$manifest" >/dev/null
region=$(jq -r .region "$manifest")
account=$(jq -r .account "$manifest")
release=$(jq -r .release "$manifest")
image=$(jq -r .image "$manifest")
secret_arn=$(jq -r .secretArn "$manifest")
registry="$account.dkr.ecr.$region.amazonaws.com"
[[ $image =~ ^$account\.dkr\.ecr\.$region\.amazonaws\.com/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ $secret_arn =~ ^arn:aws:secretsmanager:$region:$account:secret:[A-Za-z0-9/_+=.@-]+$ ]] || exit 1
[[ $(aws sts get-caller-identity --region "$region" --query Account --output text) == "$account" ]] || exit 1

name=testcraft-evals
previous=testcraft-evals-previous
check="testcraft-evals-check-$release"
exists() { docker container inspect "$1" >/dev/null 2>&1; }
running() { [[ $(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }
if exists "$previous" || exists "$check"; then
  echo 'A previous deployment needs inspection. No containers or data were changed.' >&2; exit 1
fi
task_dir=$(mktemp -d /run/testcraft-deploy-XXXXXX)
new_created=false
renamed=false
draining=false
success=false
cleanup() {
  result=$?
  trap - EXIT
  if [[ $success != true ]]; then
    if [[ $new_created == true ]] && exists "$name"; then docker stop --time 190 "$name" >/dev/null 2>&1 || true; docker rm "$name" >/dev/null 2>&1 || true; fi
    if [[ $renamed == true ]]; then docker rename "$previous" "$name" && docker start "$name" >/dev/null || true;
    elif [[ $draining == true ]] && exists "$name"; then
      if running "$name"; then docker kill --signal CONT "$name" >/dev/null || true; else docker start "$name" >/dev/null || true; fi
    fi
    echo 'Deployment failed. The previous container was kept or restart was attempted; verify its health before retrying. The database was not restored or deleted.' >&2
  fi
  if exists "$check"; then docker stop --time 20 "$check" >/dev/null 2>&1 || true; docker rm "$check" >/dev/null 2>&1 || true; fi
  rm -f "$task_dir/runtime.env" "$task_dir/docker/config.json"
  rmdir "$task_dir/docker" "$task_dir" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT

mkdir "$task_dir/docker"
aws ecr get-login-password --region "$region" | docker --config "$task_dir/docker" login --username AWS --password-stdin "$registry" >/dev/null
docker --config "$task_dir/docker" pull "$image" >/dev/null
# These are identifiers/settings, never API keys or AWS access credentials.
jq -r '"APP_ORIGIN=" + .origin, "AWS_REGION=" + .region, "AWS_SECRET_ARN=" + .secretArn,
  "WORKSHOP_ID=" + .workshop, "WORKSHOP_MAX_MODEL_CALLS=" + (.allowance|tostring),
  "APP_RELEASE=" + .release, "WORKSHOP_SESSION_HOURS=24", "AWS_EC2_METADATA_V1_DISABLED=true"' "$manifest" > "$task_dir/runtime.env"
options=(--read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128
  --memory 768m --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,size=64m --env-file "$task_dir/runtime.env"
  --log-driver local --log-opt max-size=10m --log-opt max-file=3)
probe() {
  docker exec "$1" node --input-type=module -e '
    const r=await fetch("http://127.0.0.1:3000/healthz",{signal:AbortSignal.timeout(3000)});
    const h=await r.json();
    if(process.argv[1]==="idle" ? h.status!=="draining" || !h.idle : !r.ok || h.release!==process.env.APP_RELEASE)process.exit(1);
  ' "${2:-ready}" >/dev/null 2>&1
}
healthy() { for ((i=0;i<45;i++)); do if probe "$1"; then return 0; fi; sleep 2; done; return 1; }

# Startup/secret-access rehearsal uses an empty temporary DB, never the participant DB.
docker run -d --name "$check" "${options[@]}" --tmpfs /data:rw,noexec,nosuid,uid=1000,gid=1000,size=64m "$image" >/dev/null
healthy "$check" || { echo 'New image failed its startup/Secrets Manager check. Current service unchanged.' >&2; exit 1; }
docker stop --time 20 "$check" >/dev/null
docker rm "$check" >/dev/null

if running "$name"; then
  docker kill --signal USR2 "$name" >/dev/null
  draining=true
  drained=false
  for ((i=0;i<120;i++)); do if probe "$name" idle; then drained=true; break; fi; sleep 5; done
  [[ $drained == true ]] || { echo 'Runs did not finish in ten minutes. Cancelling deployment and reopening admission.' >&2; exit 1; }
  docker stop --time 190 "$name" >/dev/null
fi
if exists "$name"; then docker rename "$name" "$previous"; renamed=true; fi

install -d -m 700 -o 1000 -g 1000 /var/lib/testcraft-evals/data
install -d -m 700 /var/lib/testcraft-evals/backups
backup=$(mktemp "/var/lib/testcraft-evals/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ)-$release-XXXXXX.tar.gz")
tar -czf "$backup" -C /var/lib/testcraft-evals/data .
new_created=true
docker run -d --name "$name" --restart unless-stopped "${options[@]}" \
  -p 3000:3000 --mount type=bind,src=/var/lib/testcraft-evals/data,dst=/data "$image" >/dev/null
healthy "$name" || { echo 'New service failed health verification.' >&2; exit 1; }
success=true
if [[ $renamed == true ]]; then docker rm "$previous" >/dev/null; fi
echo "Release $release is healthy. Previous database backup retained on the data volume."
