# Локализация интерфейса

Языки интерфейса: `ru` (основной и исходный), `en`, `es`, `pt-BR`, `fr`, `de`, `zh-CN` (спецификация, §44). Каталоги переводов лежат в `packages/shared/src/i18n/<язык>/<пространство имён>.json`, полноту проверяет `pnpm i18n:check`.

## Глоссарий

Термины переводятся только так, как указано в таблице, во всех каталогах и во всех разделах интерфейса. Роли пишутся с прописной буквы, как названия (в интерфейсе они стоят отдельно: в таблице пользователей, в меню).

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| шаблон | template | plantilla | modelo | modèle | Vorlage | 模板 |
| отчёт | report | informe | relatório | rapport | Bericht | 报表 |
| запуск (построение отчёта) | run | ejecución | execução | exécution | Ausführung | 运行 |
| сформировать (кнопка) | Generate | Generar | Gerar | Générer | Erstellen | 生成 |
| история (запусков) | history | historial | histórico | historique | Verlauf | 历史记录 |
| источник данных | data source | origen de datos | fonte de dados | source de données | Datenquelle | 数据源 |
| запрос | query | consulta | consulta | requête | Abfrage | 查询 |
| параметр | parameter | parámetro | parâmetro | paramètre | Parameter | 参数 |
| диаграмма | chart | gráfico | gráfico | graphique | Diagramm | 图表 |
| группа (пользователей) | group | grupo | grupo | groupe | Gruppe | 用户组 |
| категория (шаблонов) | category | categoría | categoria | catégorie | Kategorie | 类别 |
| доступен всем | available to everyone | disponible para todos | disponível para todos | accessible à tous | für alle verfügbar | 所有人可用 |
| владелец | owner | propietario | proprietário | propriétaire | Eigentümer | 所有者 |
| Редактор (роль) | Editor | Editor | Editor | Éditeur | Bearbeiter | 编辑者 |
| Менеджер безопасности (роль) | Security manager | Responsable de seguridad | Gerente de segurança | Responsable de la sécurité | Sicherheitsbeauftragter | 安全管理员 |
| Администратор (роль) | Administrator | Administrador | Administrador | Administrateur | Administrator | 管理员 |
| Пользователь (роль) | User | Usuario | Usuário | Utilisateur | Benutzer | 用户 |
| подпись (электронная) | signature | firma | assinatura | signature | Signatur | 签名 |
| штамп (подписи) | stamp | sello | carimbo | cachet | Stempel | 签章 |
| сертификат | certificate | certificado | certificado | certificat | Zertifikat | 证书 |
| превью | preview | vista previa | pré-visualização | aperçu | Vorschau | 预览 |
| выгрузить (архив шаблонов) | export | exportar | exportar | exporter | exportieren | 导出 |
| загрузить из архива | import from archive | importar desde archivo ZIP | importar de arquivo ZIP | importer depuis une archive | aus Archiv importieren | 从压缩包导入 |
| архив (шаблонов) | archive | archivo ZIP | arquivo ZIP | archive | Archiv | 压缩包 |
| блокировка правки | edit lock | bloqueo de edición | bloqueio de edição | verrouillage de modification | Bearbeitungssperre | 编辑锁定 |
| резервная копия | backup | copia de seguridad | backup | sauvegarde | Sicherung | 备份 |
| режим обслуживания | maintenance mode | modo de mantenimiento | modo de manutenção | mode maintenance | Wartungsmodus | 维护模式 |

Общие кнопки и состояния (`common:action.*`, `common:status.*`):

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| Сохранить | Save | Guardar | Salvar | Enregistrer | Speichern | 保存 |
| Отмена | Cancel | Cancelar | Cancelar | Annuler | Abbrechen | 取消 |
| Удалить | Delete | Eliminar | Excluir | Supprimer | Löschen | 删除 |
| Закрыть | Close | Cerrar | Fechar | Fermer | Schließen | 关闭 |
| Изменить | Edit | Editar | Editar | Modifier | Bearbeiten | 编辑 |
| Добавить | Add | Añadir | Adicionar | Ajouter | Hinzufügen | 添加 |
| Загрузка… | Loading… | Cargando… | Carregando… | Chargement… | Wird geladen… | 正在加载… |
| Ошибка | Error | Error | Erro | Erreur | Fehler | 错误 |
| Как в браузере | Browser default | Según el navegador | Igual ao navegador | Langue du navigateur | Wie im Browser | 跟随浏览器 |

Подписи интерфейса, на которые ссылаются ошибки API (`errors`, `validation`): веб переводит эти разделы, кнопки и режимы так же.

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| Выйти везде | Sign out everywhere | Cerrar sesión en todas partes | Sair de todos os lugares | Se déconnecter partout | Überall abmelden | 在所有设备上退出 |
| Моя подпись | My signature | Mi firma | Minha assinatura | Ma signature | Meine Signatur | 我的签名 |
| Справка по шаблонам | Template help | Ayuda sobre plantillas | Ajuda sobre modelos | Aide sur les modèles | Hilfe zu Vorlagen | 模板帮助 |
| Список строк (режим запроса) | List of rows | Lista de filas | Lista de linhas | Liste de lignes | Liste von Zeilen | 行列表 |
| SQL-список (тип параметра) | SQL list | Lista SQL | Lista SQL | Liste SQL | SQL-Liste | SQL 列表 |
| SSL с проверкой | SSL with verification | SSL con verificación | SSL com verificação | SSL avec vérification | SSL mit Prüfung | SSL（验证证书） |
| обновить / копия / пропустить (загрузка из архива) | update / copy / skip | actualizar / copia / omitir | atualizar / cópia / ignorar | mettre à jour / copie / ignorer | aktualisieren / Kopie / überspringen | 更新 / 副本 / 跳过 |

## Правила перевода

- Источник текстов — `ru`. Русские тексты при переносе в каталог не меняются.
- Термины — строго по глоссарию. Новый термин сначала добавляется в глоссарий, потом в каталоги.
- Тон нейтральный, деловой. Обращение на «вы» там, где язык различает формы: `de` — «Sie», `fr` — «vous», `es` и `pt-BR` — нейтральные формы без «tú»/«tu».
- Кавычки и пробелы — по нормам языка:
  - `ru` — «ёлочки»;
  - `en` — “…”;
  - `es` — «…»; `pt-BR` — “…”;
  - `fr` — « … » с неразрывными пробелами внутри и неразрывный пробел перед `: ; ! ?`;
  - `de` — „…“;
  - `zh-CN` — полноширинная пунктуация `，。：；！？` и кавычки “…”.
- Термины интерфейса в кавычках (названия разделов, кнопок) совпадают с переводом самих разделов и кнопок.
- Параметры `{{name}}` в переводе те же, что в `ru`: их нельзя переименовывать, удалять или добавлять.
- Множественное число — суффиксами CLDR (`Intl.PluralRules(locale).resolvedOptions().pluralCategories`): `ru` — `_one/_few/_many/_other`, `en` и `de` — `_one/_other`, `es`, `pt-BR` и `fr` — `_one/_many/_other`, `zh-CN` — только `_other`.
- Фразы не склеиваются из кусков: каждая фраза — один ключ с параметрами, порядок слов задаёт перевод.
- Не переводятся: журнал сервера, ошибки конфигурации (`config.ts`), сообщения CLI-скриптов. На этапе 1 также не переводятся справка по шаблонам (этап 3), штамп подписи и `CARBONE_LANG` (этап 2), README и документация, кроме этого документа (этап 4).
