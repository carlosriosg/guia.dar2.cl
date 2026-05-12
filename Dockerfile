# Dockerfile mínimo y robusto para Coolify.
# php:8.3-apache trae todo lo necesario: PHP 8.3 + Apache + cURL extension +
# OpenSSL extension. Solo agregamos mod_rewrite + AllowOverride para .htaccess.

FROM php:8.3-apache

# Habilitar mod_rewrite/headers + permitir .htaccess + suprimir warning ServerName.
# Todo en un solo RUN para minimizar layers y puntos de falla.
RUN a2enmod rewrite headers \
    && sed -ri -e 's!AllowOverride None!AllowOverride All!g' /etc/apache2/apache2.conf \
    && echo "ServerName localhost" >> /etc/apache2/apache2.conf

# Copiar el sitio + crear /private/ con permisos correctos.
COPY . /var/www/html/

RUN mkdir -p /var/www/html/private \
    && printf "Order deny,allow\nDeny from all\n" > /var/www/html/private/.htaccess \
    && chown -R www-data:www-data /var/www/html

EXPOSE 80
