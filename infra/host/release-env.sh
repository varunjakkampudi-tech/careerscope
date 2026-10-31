#!/usr/bin/env bash
# Sourced helper: reads the release record written by build-images.sh and verifies it.
# Defines load_release, which exports CAREERSCOPE_IMAGE and CAREERSCOPE_PROXY_IMAGE and fails closed
# (returns non-zero with a message) if the record is missing, a value is missing or mutable, the
# revision does not match DEPLOYED_COMMIT, or a tag no longer resolves to the recorded image ID.
#
# A missing DEPLOYED_COMMIT also fails closed, unless the operator passes --first-deploy.
#
# Usage: . release-env.sh; load_release <deployment-root> [--first-deploy]

load_release() {
  local root=$1 first_deploy=${2:-} record="$1/RELEASE_RECORD" key value
  local revision="" image="" image_id="" proxy="" proxy_id=""
  if [ ! -f "$record" ]; then
    echo "No release record at $record: run host/build-images.sh first" >&2
    return 1
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      REVISION) revision=$value ;;
      CAREERSCOPE_IMAGE) image=$value ;;
      CAREERSCOPE_IMAGE_ID) image_id=$value ;;
      CAREERSCOPE_PROXY_IMAGE) proxy=$value ;;
      CAREERSCOPE_PROXY_IMAGE_ID) proxy_id=$value ;;
    esac
  done <"$record"

  local short=${revision:0:12}
  if ! [[ "$revision" =~ ^[0-9a-f]{12,40}$ ]]; then
    echo "Release record has no valid REVISION" >&2
    return 1
  fi
  if [ -f "$root/DEPLOYED_COMMIT" ]; then
    if [ "$(cat "$root/DEPLOYED_COMMIT")" != "$revision" ]; then
      echo "Release record revision does not match DEPLOYED_COMMIT; rebuild with build-images.sh" >&2
      return 1
    fi
  elif [ "$first_deploy" != "--first-deploy" ]; then
    echo "No DEPLOYED_COMMIT at $root, so the release record cannot be tied to a shipped revision. Ship with host/ship.sh, or pass --first-deploy if this is the first deploy on this host" >&2
    return 1
  else
    echo "WARNING: no DEPLOYED_COMMIT at $root; continuing because --first-deploy was passed" >&2
  fi
  if [ "$image" != "careerscope:$short" ] || [ "$proxy" != "careerscope:$short-proxy" ]; then
    echo "Release record image names are not the immutable revision tags" >&2
    return 1
  fi
  local pattern='^sha256:[0-9a-f]{64}$'
  if ! [[ "$image_id" =~ $pattern ]] || ! [[ "$proxy_id" =~ $pattern ]]; then
    echo "Release record is missing a recorded image digest" >&2
    return 1
  fi
  local actual
  actual=$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)
  if [ "$actual" != "$image_id" ]; then
    echo "Runtime image $image does not match the recorded digest; rebuild with build-images.sh" >&2
    return 1
  fi
  actual=$(docker image inspect "$proxy" --format '{{.Id}}' 2>/dev/null || true)
  if [ "$actual" != "$proxy_id" ]; then
    echo "Proxy image $proxy does not match the recorded digest; rebuild with build-images.sh" >&2
    return 1
  fi
  export CAREERSCOPE_IMAGE=$image CAREERSCOPE_PROXY_IMAGE=$proxy
}
