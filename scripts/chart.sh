#!/bin/sh
# Проверки чарта через Docker-образы с закреплёнными версиями — локально и в CI одинаково (§27.9):
#   sh scripts/chart.sh [files|lint|unittest|kubeconform|all]
set -eu
cd "$(dirname "$0")/.."
CHART=charts/carbone-reports
HELM_IMAGE=alpine/helm:4.3.0
UNITTEST_VERSION=v1.2.1
PLUGINS="${XDG_CACHE_HOME:-$HOME/.cache}/carbone-reports/helm-plugins"
KUBECONFORM_IMAGE=ghcr.io/yannh/kubeconform:v0.8.0
K8S_VERSION=1.33.0

helm() { docker run --rm -v "$PWD:/apps" -w /apps "$HELM_IMAGE" "$@"; }

# Скрипт SeaweedFS в чарте — копия docker/s3/entrypoint.sh (чарт не читает файлы вне своего каталога).
files() {
  cmp -s docker/s3/entrypoint.sh "$CHART/files/s3-entrypoint.sh" || {
    echo "$CHART/files/s3-entrypoint.sh расходится с docker/s3/entrypoint.sh: скопируйте файл" >&2
    exit 1
  }
}
lint() { for v in "$CHART"/ci/*.yaml; do helm lint --strict "$CHART" -f "$v"; done; }
# helm-unittest — плагин Helm, закреплённый версией, внутри alpine/helm (образ helmunittest тянет 1,2 ГБ).
# Плагин ставится один раз в кэш на хосте (HELM_PLUGINS); повторные запуски идут без сети.
# Helm 4 требует --verify=false: у плагина из репозитория GitHub нет подписи для проверки.
unittest() {
  mkdir -p "$PLUGINS"
  [ -d "$PLUGINS/helm-unittest" ] || docker run --rm -v "$PLUGINS:/plugins" -e HELM_PLUGINS=/plugins "$HELM_IMAGE" \
    plugin install --verify=false https://github.com/helm-unittest/helm-unittest --version "$UNITTEST_VERSION"
  docker run --rm -v "$PWD:/apps" -v "$PLUGINS:/plugins" -e HELM_PLUGINS=/plugins -w /apps "$HELM_IMAGE" unittest "$CHART"
}
kubeconform() {
  for v in "$CHART"/ci/*.yaml; do
    echo "== kubeconform: $v"
    helm template cr "$CHART" -f "$v" --namespace cr |
      docker run --rm -i "$KUBECONFORM_IMAGE" -strict -summary -kubernetes-version "$K8S_VERSION" -
  done
}

case "${1:-all}" in
  files) files ;;
  lint) lint ;;
  unittest) unittest ;;
  kubeconform) kubeconform ;;
  all) files && lint && unittest && kubeconform ;;
  *)
    echo "использование: sh scripts/chart.sh [files|lint|unittest|kubeconform|all]" >&2
    exit 2
    ;;
esac
