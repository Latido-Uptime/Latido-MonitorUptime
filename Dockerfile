# Comprobador de Latido para Fly.io: sin puertos abiertos; en la base de datos solo puede
# llamar a checker_claim y checker_report (rol latido_checker).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY ssrf-guard.js ./
COPY monitor/check.mjs monitor/email.mjs monitor/run.mjs ./monitor/
USER node
ENV NODE_ENV=production
CMD ["node", "monitor/run.mjs"]
