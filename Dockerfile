# Comprobador de Latido para Fly.io: sin puertos abiertos; en la base de datos solo puede
# llamar a checker_claim, checker_report, checker_alerts_due y checker_alert_sent (rol latido_checker).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY ssrf-guard.js errores.js ./
COPY monitor/check.mjs monitor/email.mjs monitor/run.mjs ./monitor/
USER node
ENV NODE_ENV=production
CMD ["node", "monitor/run.mjs"]
