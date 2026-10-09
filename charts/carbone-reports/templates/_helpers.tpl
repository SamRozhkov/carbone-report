{{/* Имя чарта и полное имя релиза (стандарт helm create). */}}
{{- define "cr.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "cr.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Имя ресурса компонента: <fullname>-<name>, не длиннее 63 символов. dict: root, name. */}}
{{- define "cr.component" -}}
{{- printf "%s-%s" (include "cr.fullname" .root | trunc 50 | trimSuffix "-") .name }}
{{- end }}

{{/* Полное имя сервиса компонента: резолвер nginx не применяет домены поиска. dict: root, name. */}}
{{- define "cr.fqdn" -}}
{{- printf "%s.%s.svc.%s" (include "cr.component" .) .root.Release.Namespace .root.Values.clusterDomain }}
{{- end }}

{{- define "cr.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "cr.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* dict: root, component. */}}
{{- define "cr.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cr.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Образ приложения api | web | backup с общим тегом. dict: root, name. */}}
{{- define "cr.image" -}}
{{- printf "%s/carbone-report-%s:%s" .root.Values.image.registry .name (default .root.Chart.AppVersion .root.Values.image.tag) }}
{{- end }}

{{- define "cr.secretName" -}}
{{- default (include "cr.fullname" .) .Values.existingSecret }}
{{- end }}

{{/* Переменная окружения из Secret. dict: root, env, key, optional. */}}
{{- define "cr.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "cr.secretName" .root }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end }}

{{- define "cr.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cr.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Общее в spec пода: учётная запись без токена API и секреты для образов. */}}
{{- define "cr.podDefaults" -}}
serviceAccountName: {{ include "cr.serviceAccountName" . }}
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* nodeSelector, tolerations, affinity компонента: аргумент — его values. */}}
{{- define "cr.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* Postgres: встроенный или внешний. */}}
{{- define "cr.db.host" -}}
{{- if .Values.postgresql.enabled }}{{ include "cr.component" (dict "root" . "name" "postgresql") }}{{ else }}{{ .Values.externalDatabase.host }}{{ end }}
{{- end }}
{{- define "cr.db.port" -}}
{{- if .Values.postgresql.enabled }}5432{{ else }}{{ .Values.externalDatabase.port }}{{ end }}
{{- end }}
{{- define "cr.db.name" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.database }}{{ else }}{{ .Values.externalDatabase.database }}{{ end }}
{{- end }}
{{- define "cr.db.user" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.user }}{{ else }}{{ .Values.externalDatabase.user }}{{ end }}
{{- end }}
{{- define "cr.db.sslMode" -}}
{{- if .Values.postgresql.enabled }}disable{{ else }}{{ .Values.externalDatabase.sslMode }}{{ end }}
{{- end }}
{{/* Путь к CA внешнего Postgres в контейнере; пусто — CA не задан. */}}
{{- define "cr.db.caPath" -}}
{{- if and (not .Values.postgresql.enabled) .Values.externalDatabase.caSecret.name }}/etc/carbone-reports/pg-ca/{{ .Values.externalDatabase.caSecret.key }}{{ end }}
{{- end }}

{{/*
URL базы без пароля (пароль — DATABASE_PASSWORD, его вставляет API). uselibpqcompat — режимы sslmode
как в libpq: иначе pg считает require и verify-ca синонимами verify-full.
*/}}
{{- define "cr.databaseUrl" -}}
{{- $mode := include "cr.db.sslMode" . -}}
{{- $url := printf "postgres://%s@%s:%s/%s?sslmode=%s" (include "cr.db.user" . | urlquery) (include "cr.db.host" .) (include "cr.db.port" .) (include "cr.db.name" .) $mode -}}
{{- if ne $mode "disable" }}{{ $url = printf "%s&uselibpqcompat=true" $url }}{{ end -}}
{{- with include "cr.db.caPath" . }}{{ $url = printf "%s&sslrootcert=%s" $url . }}{{ end -}}
{{- $url }}
{{- end }}

{{/* URL Redis без пароля (пароль — REDIS_PASSWORD). */}}
{{- define "cr.redisUrl" -}}
{{- if .Values.redis.enabled }}{{ printf "redis://%s:6379" (include "cr.component" (dict "root" . "name" "redis")) }}{{ else }}{{ .Values.externalRedis.url }}{{ end }}
{{- end }}

{{- define "cr.carboneUrl" -}}
{{- if .Values.carbone.enabled }}{{ printf "http://%s:4000" (include "cr.component" (dict "root" . "name" "carbone")) }}{{ else }}{{ .Values.carbone.url }}{{ end }}
{{- end }}

{{- define "cr.onlyofficeUrl" -}}
{{- if .Values.onlyoffice.enabled }}{{ printf "http://%s" (include "cr.component" (dict "root" . "name" "onlyoffice")) }}{{ else }}{{ .Values.onlyoffice.internalUrl }}{{ end }}
{{- end }}

{{/* Настройки S3 (строки data ConfigMap): встроенный SeaweedFS или внешний S3. */}}
{{- define "cr.s3Config" -}}
STORAGE_BACKEND: s3
{{- if .Values.s3.enabled }}
S3_ENDPOINT: {{ printf "http://%s:8333" (include "cr.component" (dict "root" . "name" "s3")) | quote }}
S3_REGION: us-east-1
S3_BUCKET: {{ .Values.s3.bucket | quote }}
S3_FORCE_PATH_STYLE: "true"
S3_CREATE_BUCKET: "true"
{{- else }}
S3_ENDPOINT: {{ .Values.externalS3.endpoint | quote }}
S3_REGION: {{ .Values.externalS3.region | quote }}
S3_BUCKET: {{ .Values.externalS3.bucket | quote }}
S3_FORCE_PATH_STYLE: {{ .Values.externalS3.forcePathStyle | toString | quote }}
S3_CREATE_BUCKET: {{ .Values.externalS3.createBucket | toString | quote }}
{{- end }}
{{- end }}
