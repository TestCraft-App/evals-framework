FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
COPY src/evals ./src/evals
COPY src/runtime ./src/runtime
COPY public/index.html public/app.js public/run-detail.js public/requests.js public/styles.css ./public/
COPY public/assets ./public/assets/
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 TESTCRAFT_EVALS_DB=/data/evals.sqlite
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(3000)});if(!r.ok)process.exit(1)"]
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
