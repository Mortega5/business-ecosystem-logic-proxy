FROM node:26

LABEL Maintainer="Future Internet Consulting and Development Solutions S.L."

RUN npm install -g pnpm@12.16.1

WORKDIR /business-ecosystem-logic-proxy

COPY ./entrypoint.sh /

EXPOSE 8004

ENTRYPOINT ["/entrypoint.sh"]
