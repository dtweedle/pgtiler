FROM ubuntu:24.04 AS builder
RUN apt-get update && apt-get install -y build-essential libsqlite3-dev zlib1g-dev git
RUN git clone https://github.com/felt/tippecanoe.git /tmp/tippecanoe \
    && cd /tmp/tippecanoe && make -j$(nproc) && make install

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/tippecanoe /usr/local/bin/
COPY --from=builder /usr/local/bin/tile-join /usr/local/bin/
COPY --from=builder /usr/local/bin/tippecanoe-decode /usr/local/bin/
WORKDIR /data
