set -euo pipefail
umask 077
# task_volume_id is supplied by CloudFormation, never discovered by disk position.
[[ $task_volume_id =~ ^vol-[a-f0-9]+$ ]] || exit 1
dnf install -y docker jq awscli-2
systemctl enable --now docker amazon-ssm-agent

task_serial=$(printf '%s' "$task_volume_id" | tr -d '-')
task_device=''
for ((attempt=0; attempt<120; attempt++)); do
  while read -r task_name task_found_serial; do
    if [[ $task_found_serial == "$task_serial" ]]; then task_device="/dev/$task_name"; break; fi
  done < <(lsblk -dn -o NAME,SERIAL)
  [[ -n $task_device ]] && break
  sleep 2
done
[[ -b $task_device ]] || { echo 'Dedicated EBS volume not found; no disk was changed.' >&2; exit 1; }
[[ $(lsblk -dn -o TYPE "$task_device") == disk ]] || exit 1
# Refuse partitioned, mounted or unexpectedly formatted devices.
[[ $(lsblk -nr -o NAME "$task_device" | wc -l) == 1 ]] || exit 1
[[ -z $(lsblk -dn -o MOUNTPOINTS "$task_device" | tr -d '[:space:]') ]] || exit 1
task_type=$(blkid -s TYPE -o value "$task_device" || true)
if [[ -z $task_type ]]; then
  [[ -z $(wipefs --no-act --noheadings --output TYPE "$task_device") ]] || exit 1
  mkfs.ext4 "$task_device"
elif [[ $task_type != ext4 ]]; then
  echo 'Unexpected filesystem; refusing to format.' >&2; exit 1
fi
task_uuid=$(blkid -s UUID -o value "$task_device")
[[ $task_uuid =~ ^[a-f0-9-]+$ ]] || exit 1
install -d -m 700 /var/lib/testcraft-evals
if ! grep -qF "UUID=$task_uuid " /etc/fstab; then
  printf 'UUID=%s /var/lib/testcraft-evals ext4 defaults 0 2\n' "$task_uuid" >> /etc/fstab
fi
mount /var/lib/testcraft-evals
mountpoint -q /var/lib/testcraft-evals
install -d -m 700 -o 1000 -g 1000 /var/lib/testcraft-evals/data
install -d -m 700 /var/lib/testcraft-evals/backups
echo 'TestCraft host ready; waiting for an application release.'
