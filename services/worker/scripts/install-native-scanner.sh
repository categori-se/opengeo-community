#!/usr/bin/env bash
# Install only the reviewed supplementary scanner; never execute a remote installer.
set -euo pipefail
umask 0077

if [[ "$#" != 1 || "$1" != /* || "$1" == / ]]; then
  echo "Usage: install-native-scanner.sh ABSOLUTE_NEW_DIRECTORY" >&2
  exit 1
fi
destination="$1"
mkdir -- "$destination"
case "$(uname -m)" in
  x86_64)
    architecture=amd64
    checksum=1d444c5e7360471815f7158f71935fcecc68a3c417d85c7344f770854300bba2
    ;;
  aarch64|arm64)
    architecture=arm64
    checksum=32aceeb8ee837244775fcb522372c8b3a47914986385f3148f4ee2c930482a84
    ;;
  *) echo "Native scanner supports only amd64 and arm64" >&2; exit 1 ;;
esac
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --connect-timeout 15 --max-time 180 \
  --output "$destination/grype.tar.gz" \
  "https://github.com/anchore/grype/releases/download/v0.118.0/grype_0.118.0_linux_${architecture}.tar.gz"
printf '%s  %s\n' "$checksum" "$destination/grype.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file "$destination/grype.tar.gz" --directory "$destination" \
  --no-same-owner --no-same-permissions grype
chmod 0500 "$destination/grype"
GRYPE_CHECK_FOR_APP_UPDATE=false "$destination/grype" version --output json
