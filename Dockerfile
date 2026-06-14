FROM node as jsbuilder

COPY . /app
WORKDIR /app

RUN npm install

# ---------------------------------------------------------

FROM node:slim

COPY --from=jsbuilder /app /app

WORKDIR /app

ENV SHE_DATA_DIR=/var/lib/she
EXPOSE 8080
ENTRYPOINT [ "node", "src/index.js" ]
