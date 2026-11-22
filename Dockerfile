FROM node:24-bookworm-slim

WORKDIR /app
COPY server.mjs server-app.mjs tongjorim-store.mjs ./
COPY public/ ./public/

USER node
CMD ["node", "server.mjs"]
