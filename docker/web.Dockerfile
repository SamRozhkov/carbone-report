FROM nginx:1.30-alpine
COPY docker/nginx/maps.conf /etc/nginx/conf.d/00-maps.conf
COPY docker/nginx/common.conf /etc/nginx/snippets/common.conf
COPY docker/nginx/prod.conf /etc/nginx/conf.d/default.conf
COPY docker/web/placeholder/ /usr/share/nginx/html/
