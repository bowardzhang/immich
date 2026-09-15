FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./

ENV PHOTO_STORAGE_ROOT=/photos_extern
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "server.mjs"]
