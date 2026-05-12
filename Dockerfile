# Dockerfile para deploy en Coolify (o cualquier VPS con Docker).
# Sirve el sitio estático + procesa los .php (proxy.php necesario para
# noticias RSS, acceso privado, listas IPTV, etc.).
#
# En Coolify:
#   1. Crear nueva "Application"
#   2. Tipo: "Docker Compose" o "Dockerfile"
#   3. Apuntar al repo Git de este proyecto
#   4. Coolify detecta este Dockerfile y lo buildea
#   5. Listo

FROM php:8.3-apache

# Módulos Apache necesarios:
#  - rewrite: para .htaccess (auth, redirects)
#  - headers: para los CORS headers de proxy.php
#  - expires: opcional, para cache-control
RUN a2enmod rewrite headers expires

# Permitir .htaccess en /var/www/html (AllowOverride All)
RUN sed -i 's!<Directory /var/www/>!<Directory /var/www/>\n\tAllowOverride All!' /etc/apache2/apache2.conf || true

# Evitar warning de Apache pidiendo ServerName
RUN echo "ServerName localhost" >> /etc/apache2/apache2.conf

# Asegurar PHP procesa los .php (viene en la imagen base php:8.3-apache pero
# explícito por las dudas)
RUN echo "AddType application/x-httpd-php .php" > /etc/apache2/conf-available/php-handler.conf \
    && a2enconf php-handler

# Copiar todo el sitio al docroot
COPY . /var/www/html/

# La carpeta private/ está en .gitignore (contiene secretos), así que no
# se copia. La creamos vacía + escribible para que el bootstrap inicial y
# proxy.php puedan generar .secret y persistir users.json/lists.json.
# Si Coolify monta un Persistent Volume en /var/www/html/private, sobrescribe
# este directorio vacío con datos persistentes entre re-deploys.
RUN mkdir -p /var/www/html/private \
    && chown -R www-data:www-data /var/www/html \
    && chmod -R 755 /var/www/html \
    && chmod -R 775 /var/www/html/private

# .htaccess dentro de private/ para bloquear acceso web directo a users.json
RUN printf "Order deny,allow\nDeny from all\n\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n" > /var/www/html/private/.htaccess \
    && chown www-data:www-data /var/www/html/private/.htaccess

# Exponer puerto HTTP estándar
EXPOSE 80

# CMD viene de la imagen base (apache2-foreground)
