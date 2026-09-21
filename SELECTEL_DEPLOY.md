# Развёртывание ListingFlow на Selectel

Приложение рассчитано на один постоянно работающий Node.js-процесс. Данные SaaS, индексы фидов, мониторинг и Telegram-связки хранятся на постоянном диске сервера.

## Каталоги

```text
/opt/feeddev-saas      код приложения
/var/lib/feeddev-saas  постоянные данные
/etc/feeddev-saas.env  секреты и настройки
```

Каталог `/var/lib/feeddev-saas` нельзя заменять при выкладке новой версии. Делайте его резервную копию вместе с файлом окружения.

## Переменные окружения

```env
NODE_ENV=production
APP_MODE=external
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/feeddev-saas
BACKUP_DIR=/var/backups/listingflow
BACKUP_RETENTION_DAYS=30
PUBLIC_BASE_URL=https://app.example.ru
TRUST_PROXY=true
PASSWORD_RESET_MINUTES=30
BILLING_MODE=manual

LEGAL_NAME=ИП Якубаш С.Д.
LEGAL_INN=720326517332
LEGAL_OGRNIP=326723200087150
LEGAL_ADDRESS=полный адрес для юридически значимых сообщений
LEGAL_EMAIL=legal@example.ru
LEGAL_PHONE=+7...

SAAS_SESSION_SECRET=replace-with-long-random-value
SAAS_DATA_SECRET=replace-with-another-long-random-value
EXTERNAL_ADMIN_EMAIL=owner@example.ru
EXTERNAL_ADMIN_PASSWORD=replace-with-strong-password

FREEKASSA_MERCHANT_ID=
FREEKASSA_SECRET_1=
FREEKASSA_SECRET_2=

TELEGRAM_BOT_TOKEN=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=ListingFlow <notifications@example.ru>
```

Пока касса не выбрана, оставьте `BILLING_MODE=manual`: кабинет покажет кнопку запроса счёта на `LEGAL_EMAIL`. После подключения FreeKassa заполните три её секрета и смените значение на `freekassa`.

Не задавайте `BLOB_READ_WRITE_TOKEN`: на Selectel используется локальный постоянный диск и атомарная запись в `DATA_DIR`.

SMTP-параметры обязательны для восстановления пароля. Пользователь получает одноразовую ссылку, действующую 30 минут; в хранилище сохраняется только SHA-256-хеш токена.

## systemd

Создайте `/etc/systemd/system/feeddev-saas.service`:

```ini
[Unit]
Description=ListingFlow SaaS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/feeddev-saas
EnvironmentFile=/etc/feeddev-saas.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=feeddev
Group=feeddev
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Затем:

```bash
sudo install -d -o feeddev -g feeddev -m 750 /var/lib/feeddev-saas
sudo install -d -o feeddev -g feeddev -m 700 /var/backups/listingflow
sudo systemctl daemon-reload
sudo systemctl enable --now feeddev-saas
```

Проксируйте HTTPS-трафик через nginx на `127.0.0.1:3000`. Минимальная конфигурация виртуального хоста:

```nginx
server {
    listen 443 ssl http2;
    server_name app.example.ru;
    client_max_body_size 22m;

    ssl_certificate /etc/letsencrypt/live/app.example.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.ru/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 120s;
    }
}
```

Разрешите в облачном firewall и `ufw` только SSH, 80 и 443; порт 3000 наружу не открывайте. Callback FreeKassa: `https://app.example.ru/api/billing/freekassa/callback`.

## Резервное копирование

Команда `npm run backup` создаёт атомарный снимок `DATA_DIR`, добавляет `manifest.json` и удаляет снимки старше `BACKUP_RETENTION_DAYS`. `BACKUP_DIR` обязательно должен находиться вне `DATA_DIR`.

Создайте `/etc/systemd/system/listingflow-backup.service`:

```ini
[Unit]
Description=ListingFlow encrypted data backup

[Service]
Type=oneshot
WorkingDirectory=/opt/feeddev-saas
EnvironmentFile=/etc/feeddev-saas.env
ExecStart=/usr/bin/node backup.js
User=feeddev
Group=feeddev
NoNewPrivileges=true
PrivateTmp=true
```

Создайте `/etc/systemd/system/listingflow-backup.timer`:

```ini
[Unit]
Description=Daily ListingFlow backup

[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true
RandomizedDelaySec=20m

[Install]
WantedBy=timers.target
```

Активируйте и сразу проверьте первый снимок:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now listingflow-backup.timer
sudo systemctl start listingflow-backup.service
sudo systemctl status listingflow-backup.service
sudo -u feeddev ls -la /var/backups/listingflow
```

Скопируйте резервные копии ещё и в Selectel Object Storage: локальный backup на том же сервере не защищает от потери VPS. Рекомендуемый вариант — `restic` с шифрованием и S3-совместимым endpoint Selectel; пароль restic храните отдельно от сервера. Не реже раза в месяц разворачивайте свежий снимок в тестовый `DATA_DIR` и проверяйте вход, проекты и опубликованные фиды.

## Проверка перед открытием регистрации

1. Заполните полные ФИО ИП, адрес, юридический email и телефон; откройте `/legal.html` и проверьте реквизиты.
2. Получите TLS-сертификат и убедитесь, что `/api/health` возвращает `legalReady: true`.
3. Настройте SMTP и проверьте восстановление пароля на реальном почтовом адресе.
4. Выполните резервное копирование и пробное восстановление на отдельном каталоге.
5. Проверьте регистрацию, ручной запрос счёта, активацию клиента в админке и публикацию XML.
6. После выбора кассы проведите тестовый платёж и сверку callback, суммы, статуса подписки и чека.
