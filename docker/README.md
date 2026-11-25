# Business Ecosystem Logic Proxy Docker Image

This repository contains the Docker image of the Business Ecosystem Logic Proxy component of the FIWARE Business API Ecosystem GE.

You can build a docker image based on this Dockerfile. This image will contain only an instance of the Business Ecosystem Logic Proxy, exposing port `8004`. This requires that you have [docker](https://docs.docker.com/installation/) installed on your machine.

The current Business API Ecosystem can use different IDMs to run. In this way, you have to register your instance in the chosen IDM as described in the [Business API Ecosystem configuration guide](https://business-api-ecosystem.readthedocs.io/en/latest/configuration-guide.html#configuring-the-logic-proxy) before running the container since the IdM credentials are required.

If you just want to have a Business Ecosystem Logic Proxy instance running as quickly as possible jump to section *The Fastest Way*.

If you want to know what is behind the scenes of our container you can go ahead and read the build and run sections.

## The Fastest Way

The Business Ecosystem Logic Proxy uses an external MongoDB container as database and an ElasticSearch container for handling indexes.
The proxy is configured with environment variables (`BAE_*`) and, optionally, a YAML file. See [the configuration](../docs/kubernetes.md#configuration).

To run the Business Ecosystem Logic Proxy, `docker compose` can be used. You can use the `docker-compose.yml` file included
with the source of the software, or create a new one with the following content:

```
version: '3'
services:
    elasticsearch:
        image: docker.elastic.co/elasticsearch/elasticsearch:7.5.0
        environment:
            - 'node.name=BAE'
            - 'discovery.type=single-node'
            - 'ES_JAVA_OPTS=-Xms256m -Xmx256m'
        ports:
            - "127.0.0.1:9200:9200"

    mongo:
        image: mongo:4.4
        ports:
            - 27017:27017
        volumes:
            - ./proxy-data:/data/db

    proxy:
        image: fiware/biz-ecosystem-logic-proxy:master
        links:
            - mongo
        depends_on:
            - mongo
        ports:
            - 8000:8000
        environment:
            - NODE_ENV=development  # Deployment in development or in production

            - BAE_LP_PORT=8000  # Port where the node service is going to run in the container
            - BAE_LP_HOST=proxy.docker  # Host where the node service if going to run in the container
            # - BAE_SERVICE_HOST=https://store.lab.fiware.org/  # If provided, this URL specifies the actual URL that is used to access the BAE, when the component is proxied (e.g Apache)
            # - BAE_LP_HTTPS_ENABLED=true  # If provided specifies whether the service is running in HTTPS, default: false
            # - BAE_LP_HTTPS_CERT=cert/cert.crt  # Certificate for the SSL configuration (when HTTPS enabled is true)
            # - BAE_LP_HTTPS_CA=cert/ca.crt  # CA certificate for the SSL configuration (when HTTPS enabled is true)
            # - BAE_LP_HTTPS_KEY=cert/key.key  # Key sfile for the SSL configuration (when HTTPS enabled is true)
            # - BAE_LP_HTTPS_PORT=443  # Port where the service runs when SSL is enabled (when HTTPS enabled is true)

            # ------ OAUTH2 Config ------
            - BAE_LP_OAUTH2_SERVER=http://idm.docker:8000  # URL of the FIWARE IDM used for user authentication
            - BAE_LP_OAUTH2_CLIENT_ID=id  # OAuth2 Client ID of the BAE applicaiton
            - BAE_LP_OAUTH2_CLIENT_SECRET=secret  # OAuth Client Secret of the BAE application
            - BAE_LP_OAUTH2_CALLBACK=http://proxy.docker:8004/auth/fiware/callback  # Callback URL for receiving the access tokens
            - BAE_LP_OAUTH2_ADMIN_ROLE=admin  # Role defined in the IDM client app for admins of the BAE 
            - BAE_LP_OAUTH2_SELLER_ROLE=seller  # Role defined in the IDM client app for sellers of the BAE 
            - BAE_LP_OAUTH2_CUSTOMER_ROLE=customer  # Role defined in the IDM client app for customers of the BAE 
            - BAE_LP_OAUTH2_ORG_ADMIN_ROLE=orgAdmin  # Role defined in the IDM client app for organization admins of the BAE 
            - BAE_LP_OAUTH2_IS_LEGACY=false  # Whether the used FIWARE IDM is version 6 or lower

            
            # ----- Mongo Config ------
            # - BAE_LP_MONGO_USER=user
            # - BAE_LP_MONGO_PASS=pass
            - BAE_LP_MONGO_SERVER=localhost
            - BAE_LP_MONGO_PORT=27017
            - BAE_LP_MONGO_DB=belp

            - BAE_LP_REVENUE_MODEL=30  # Default market owner precentage for Revenue Sharing models

            # ----- APIs Configuration -----
            # If provided, it supports configuring the contection to the different APIs managed by the logic proxy, by default
            # apis.docker, charging.docker and rss.docker domains are configured
            # - BAE_LP_ENDPOINT_CATALOG_PATH=DSProductCatalog
            # - BAE_LP_ENDPOINT_CATALOG_PORT=8080
            # - BAE_LP_ENDPOINT_CATALOG_HOST=apis.docker
            # - BAE_LP_ENDPOINT_CATALOG_SECURED=false
            # ...
```

The image serves the compiled portal from its own files, so it has no volume to fill. `NODE_ENV` selects the development or the production mode.

The configuration is given as environment variables, as the `docker-compose.yml` file shows.

Once you have created the file, run the following command:

```
docker compose up -d
```

Then, the Business Ecosystem Logic Proxy should be up and running in `http://YOUR_HOST:PORT/` replacing `YOUR_HOST` by the host of your machine and `PORT` by the port selected in the previous step.

Once the different containers are running, you can stop them using:

```
docker compose stop
```

And start them again using:

```
docker compose start
```

Additionally, you can terminate the different containers by executing:

```
docker compose down
```

## Build the image

If you have downloaded the [Business Ecosystem Logic Proxy's source code](https://github.com/FIWARE-TMForum/business-ecosystem-logic-proxy) you can build your own image. The result will be the same, but this way you have a bit more of control of what's happening.

To create the image, from the project directory:

    docker build -t biz-ecosystem-logic-proxy  -f docker/Dockerfile .

The parameter `-t biz-ecosystem-logic-proxy` gives the image a name. This name could be anything, or even include an organization like `-t fiware/biz-ecosystem-logic-proxy`. This name is later used to run the container based on the image.
