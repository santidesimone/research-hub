# One small Node image (no Python): the app, its production dependencies, and nothing else. Runs as the unprivileged "node" user.
FROM node:20-bookworm-slim AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=deps /app/web/node_modules web/node_modules
COPY schema schema
COPY web web
USER node
EXPOSE 8080
CMD ["node", "web/server.js"]
