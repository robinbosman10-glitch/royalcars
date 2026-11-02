FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
COPY docker-entrypoint.sh /usr/local/bin/royalcars-entrypoint
RUN chmod +x /usr/local/bin/royalcars-entrypoint
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/royalcars.sqlite
EXPOSE 3000
ENTRYPOINT ["royalcars-entrypoint"]
CMD ["node", "server.mjs"]
