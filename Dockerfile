# MirrorLink server. TLS is terminated by a reverse proxy (see deploy/), so the app serves plain HTTP.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Defaults for running behind a proxy. Set TRUST_PROXY=1 only if the proxy in front is yours.
ENV PORT=3000 HOST=0.0.0.0 TLS=off
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/index.js"]
