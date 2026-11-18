FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server/server.js"]
