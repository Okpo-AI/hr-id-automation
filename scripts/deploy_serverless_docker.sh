#!/usr/bin/env bash
set -euo pipefail

# Build and push Docker image for serverless container hosting.
# Supports generic registries and prints deploy commands for Cloud Run and Railway.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE_NAME="hr-id-automation"
IMAGE_TAG="$(date +%Y%m%d-%H%M%S)"
REGISTRY=""
PLATFORM="linux/amd64"
NO_PUSH=0

usage() {
  cat <<USAGE
Usage:
  scripts/deploy_serverless_docker.sh --registry <registry> [options]

Required:
  --registry <registry>   Registry prefix (examples: ghcr.io/ORG, gcr.io/PROJECT, docker.io/USER)

Optional:
  --image <name>          Image name (default: ${IMAGE_NAME})
  --tag <tag>             Image tag (default: timestamp)
  --platform <platform>   Docker platform (default: ${PLATFORM})
  --no-push               Build only (do not push)
  -h, --help              Show help

Examples:
  scripts/deploy_serverless_docker.sh --registry ghcr.io/my-org
  scripts/deploy_serverless_docker.sh --registry gcr.io/my-project --tag v1.0.0
  scripts/deploy_serverless_docker.sh --registry docker.io/myuser --image hr-id --platform linux/amd64
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)
      REGISTRY="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE_NAME="${2:-}"
      shift 2
      ;;
    --tag)
      IMAGE_TAG="${2:-}"
      shift 2
      ;;
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$REGISTRY" ]]; then
  echo "Error: --registry is required"
  usage
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed"
  exit 1
fi

if [[ ! -f "Dockerfile" ]]; then
  echo "Error: Dockerfile not found in $ROOT_DIR"
  exit 1
fi

IMAGE_REF="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "Project: $ROOT_DIR"
echo "Image:   $IMAGE_REF"
echo "Platform:${PLATFORM}"

docker buildx inspect >/dev/null 2>&1 || docker buildx create --use >/dev/null

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "Building image (no push)..."
  docker buildx build \
    --platform "$PLATFORM" \
    -t "$IMAGE_REF" \
    --load \
    .
  echo
  echo "Build complete: $IMAGE_REF"
else
  echo "Building and pushing image..."
  docker buildx build \
    --platform "$PLATFORM" \
    -t "$IMAGE_REF" \
    --push \
    .
  echo
  echo "Push complete: $IMAGE_REF"
fi

echo
echo "Suggested deploy commands"
echo "-------------------------"
echo "Cloud Run:"
echo "gcloud run deploy ${IMAGE_NAME} --image ${IMAGE_REF} --platform managed --region <REGION> --allow-unauthenticated --port 8005"
echo
echo "Railway:"
echo "railway up --service <SERVICE_NAME> --detach"
echo "# Then set image to: ${IMAGE_REF} in Railway service settings"
echo
echo "Fly.io:"
echo "fly deploy --image ${IMAGE_REF}"
