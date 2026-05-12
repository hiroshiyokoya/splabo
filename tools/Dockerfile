FROM node:20-slim

RUN npm install --global nxapi@1.6.1-next.254

# Fetch live remote config (has current map_queries for SplatNet 3 v10) and patch
# coral: null -> { znca_version: '3.3.0' } to enable authentication
COPY nxapi-remote-config.json /usr/local/lib/node_modules/nxapi/resources/common/remote-config.json

WORKDIR /data
ENTRYPOINT ["nxapi"]
