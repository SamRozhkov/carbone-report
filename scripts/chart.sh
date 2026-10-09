#!/bin/sh
# Проверки чарта через Docker-образы с закреплёнными версиями — локально и в CI одинаково (§27.9):
#   sh scripts/chart.sh [files|lint|unittest|kubeconform|all]
set -eu
cd "$(dirname "$0")/.."
CHART=charts/carbone-reports
HELM_IMAGE=alpine/helm:4.3.0
UNITTEST_VERSION=v1.2.1
# Кэш плагина зависит от версии: смена версии или прерванная установка не используются молча.
PLUGINS="${XDG_CACHE_HOME:-$HOME/.cache}/carbone-reports/helm-plugins/$UNITTEST_VERSION"
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
# Без set -e внутри функций из цепочек: статус каждой итерации проверяем явно.
lint() {
  for v in "$CHART"/ci/*.yaml; do
    helm lint --strict "$CHART" -f "$v" || return 1
  done
}
# helm-unittest — плагин Helm, закреплённый версией, внутри alpine/helm (образ helmunittest тянет 1,2 ГБ).
# Плагин ставится один раз в кэш на хосте (HELM_PLUGINS); повторные запуски идут без сети.
# Helm 4 требует --verify=false: у плагина из репозитория GitHub нет подписи для проверки.
# Контейнер — от текущего пользователя (кэш не принадлежит root); HOME внутри — /tmp.
unittest() {
  mkdir -p "$PLUGINS"
  if [ ! -f "$PLUGINS/.installed" ]; then
    rm -rf "$PLUGINS/helm-unittest"
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PLUGINS:/plugins" -e HELM_PLUGINS=/plugins "$HELM_IMAGE" \
      plugin install --verify=false https://github.com/helm-unittest/helm-unittest --version "$UNITTEST_VERSION" || return 1
    : >"$PLUGINS/.installed"
  fi
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/apps" -v "$PLUGINS:/plugins" -e HELM_PLUGINS=/plugins \
    -w /apps "$HELM_IMAGE" unittest "$CHART"
}
# Сначала рендер в файл и проверка статуса helm: в конвейере sh без pipefail ошибка рендера дала бы
# пустой ввод и «0 ресурсов, ошибок нет».
kubeconform() {
  out=$(mktemp)
  for v in "$CHART"/ci/*.yaml; do
    echo "== kubeconform: $v"
    helm template cr "$CHART" -f "$v" --namespace cr >"$out" || { rm -f "$out"; return 1; }
    if ! grep -q '^kind:' "$out"; then
      echo "рендер $v не дал ни одного ресурса" >&2
      rm -f "$out"
      return 1
    fi
    docker run --rm -i "$KUBECONFORM_IMAGE" -strict -summary -kubernetes-version "$K8S_VERSION" - <"$out" || { rm -f "$out"; return 1; }
  done
  rm -f "$out"
}

case "${1:-all}" in
  files) files || exit 1 ;;
  lint) lint || exit 1 ;;
  unittest) unittest || exit 1 ;;
  kubeconform) kubeconform || exit 1 ;;
  all)
    files || exit 1
    lint || exit 1
    unittest || exit 1
    kubeconform || exit 1
    ;;
  *)
    echo "использование: sh scripts/chart.sh [files|lint|unittest|kubeconform|all]" >&2
    exit 2
    ;;
esac
