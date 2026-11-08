# Comprobador de Latido para Fly.io: sin puertos abiertos ni acceso a otras bases de datos.
FROM node:24-alpine
WORKDIR /app
COPY ssrf-guard.js ./
COPY monitor/check.mjs monitor/email.mjs monitor/run.mjs ./monitor/
# Usuario sin privilegios; el historial vive en el volumen /data
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DB_PATH=/data/latido.db
CMD ["node", "--disable-warning=ExperimentalWarning", "monitor/run.mjs"]
