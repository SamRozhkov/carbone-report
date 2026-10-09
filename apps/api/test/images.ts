/**
 * Официальный образ SeaweedFS для testcontainers — тот же, что у сервиса s3 в docker-compose.yml
 * (это проверяет storage-contract.int.test.ts). Индекс
 * sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d (сборка 2026-09-28).
 */
export const S3_IMAGE = 'chrislusf/seaweedfs:4.48';

/** Скрипт запуска SeaweedFS: путь в репозитории и в контейнере (как монтирует docker-compose.yml). */
export const S3_ENTRYPOINT_SOURCE = 'docker/s3/entrypoint.sh';
export const S3_ENTRYPOINT_TARGET = '/s3-entrypoint.sh';

/**
 * Тестовый OpenLDAP проекта ldapjs (на нём тестирует и библиотека ldapts): каталог
 * dc=planetexpress,dc=com, у пользователей пароль совпадает с uid. Есть сборки amd64 и arm64.
 */
export const LDAP_IMAGE = 'ghcr.io/ldapjs/docker-test-openldap/openldap:2023-10-30';

/**
 * Document Server для конвертации отчётов (docx → pdf и т. п.) — тот же образ, что у сервиса
 * onlyoffice в docker-compose.yml. Тяжёлый (около 3,4 ГБ): тест render-onlyoffice идёт только
 * в CI (TEST_ONLYOFFICE=1).
 */
export const ONLYOFFICE_IMAGE = 'onlyoffice/documentserver:9.4.0.1';
