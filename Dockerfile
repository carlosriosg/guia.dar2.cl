# Dockerfile mínimo para Coolify.
# Coolify espera el container en puerto 3000 por default — configuramos
# Apache para escuchar ahí en lugar de 80.

FROM php:8.3-apache

# Apache en puerto 3000 + mod_rewrite + AllowOverride + suppress ServerName warning.
RUN a2enmod rewrite headers \
    && sed -ri -e 's!AllowOverride None!AllowOverride All!g' /etc/apache2/apache2.conf \
    && sed -ri -e 's/Listen 80/Listen 3000/' /etc/apache2/ports.conf \
    && sed -ri -e 's/:80>/:3000>/' /etc/apache2/sites-available/000-default.conf \
    && echo "ServerName localhost" >> /etc/apache2/apache2.conf

# Copiar el sitio + crear /private/ con permisos.
COPY . /var/www/html/

RUN mkdir -p /var/www/html/private \
    && printf "Order deny,allow\nDeny from all\n" > /var/www/html/private/.htaccess \
    && chown -R www-data:www-data /var/www/html

EXPOSE 3000
