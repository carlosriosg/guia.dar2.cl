# Dockerfile para deploy en Coolify (o cualquier VPS con Docker).
# Sirve el sitio + procesa los .php (proxy.php necesario para noticias RSS,
# acceso privado, listas IPTV, etc.).
#
# En Coolify:
#   1. Build Pack: Dockerfile
#   2. Apuntar al repo Git
#   3. Coolify detecta este Dockerfile y lo buildea
#   4. Listo

FROM php:8.3-apache

# Habilitar mod_rewrite (necesario para .htaccess de auth header en LiteSpeed,
# y rewrites en general).
RUN a2enmod rewrite headers

# Permitir que .htaccess override la config (necesario para Deny from all en
# /private/, y para rewrites de auth header).
RUN sed -ri -e 's!AllowOverride None!AllowOverride All!g' /etc/apache2/apache2.conf

# Suprimir warning de ServerName (no afecta funcionalidad pero ensucia logs).
RUN echo "ServerName localhost" >> /etc/apache2/conf-available/servername.conf \
    && a2enconf servername

# Instalar dependencias del sistema + extensión PHP cURL.
# - curl (cli): útil para debug
# - ca-certificates: para verificación SSL en cURL outbound
# - libcurl4-openssl-dev: header files necesarios para compilar la
#   extensión PHP cURL (que proxy.php usa para fetch de RSS y streams)
# php:8.3-apache trae el binario PHP con CLI cURL pero a veces NO la
# extensión PHP. Forzamos la instalación con docker-php-ext-install.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates libcurl4-openssl-dev \
    && docker-php-ext-install curl \
    && rm -rf /var/lib/apt/lists/*

# Asegurar que la extensión esté habilitada (debería estarlo después
# de docker-php-ext-install, pero por las dudas).
RUN docker-php-ext-enable curl 2>/dev/null || true

# Copiar todo el sitio al docroot.
COPY . /var/www/html/

# private/ está en .gitignore (contiene secretos), así que no se copia.
# Lo creamos vacío + escribible para que proxy.php genere .secret y persista
# users.json/lists.json. Si Coolify monta un volumen acá, lo sobrescribe.
RUN mkdir -p /var/www/html/private \
    && printf "Order deny,allow\nDeny from all\n\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n" > /var/www/html/private/.htaccess \
    && chown -R www-data:www-data /var/www/html \
    && find /var/www/html -type d -exec chmod 755 {} \; \
    && find /var/www/html -type f -exec chmod 644 {} \; \
    && chmod 775 /var/www/html/private

EXPOSE 80

# CMD viene de la imagen base (apache2-foreground) — no lo sobrescribimos.
