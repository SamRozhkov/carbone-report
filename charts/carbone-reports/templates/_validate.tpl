{{/* Проверки значений: понятная ошибка вместо битых манифестов (как :? в compose). */}}
{{- define "cr.validate" -}}
{{- $v := .Values -}}
{{- if and $v.ingress.enabled (not $v.ingress.host) }}
{{- fail "ingress.host: задайте хост (например reports.example.com) или ingress.enabled=false" }}
{{- end }}
{{- if and (not $v.postgresql.enabled) (not $v.externalDatabase.host) }}
{{- fail "externalDatabase.host: задайте внешний Postgres или postgresql.enabled=true" }}
{{- end }}
{{- if not (has $v.externalDatabase.sslMode (list "disable" "require" "verify-ca" "verify-full")) }}
{{- fail "externalDatabase.sslMode: disable, require, verify-ca или verify-full" }}
{{- end }}
{{- if and (has $v.externalDatabase.sslMode (list "verify-ca" "verify-full")) (not $v.externalDatabase.caSecret.name) }}
{{- fail "externalDatabase.caSecret.name: для sslMode verify-ca и verify-full задайте Secret с CA (скрипты бэкапа проверяют сертификат)" }}
{{- end }}
{{- if and (not $v.redis.enabled) (not $v.externalRedis.url) }}
{{- fail "externalRedis.url: задайте внешний Redis (redis://host:6379, без пароля) или redis.enabled=true" }}
{{- end }}
{{- if and (not $v.s3.enabled) (not $v.externalS3.bucket) }}
{{- fail "externalS3.bucket: задайте бакет внешнего S3 или s3.enabled=true" }}
{{- end }}
{{- if and (not $v.carbone.enabled) (not $v.carbone.url) }}
{{- fail "carbone.url: задайте адрес внешнего Carbone или carbone.enabled=true" }}
{{- end }}
{{- if and (not $v.onlyoffice.enabled) (not $v.onlyoffice.internalUrl) }}
{{- fail "onlyoffice.internalUrl: задайте адрес Document Server или onlyoffice.enabled=true" }}
{{- end }}
{{- $hops := int $v.config.trustedProxyHops }}
{{- if or (lt $hops 1) (gt $hops 5) }}
{{- fail "config.trustedProxyHops: целое от 1 до 5" }}
{{- end }}
{{- end }}
