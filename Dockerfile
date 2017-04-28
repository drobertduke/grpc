FROM dockerregistry.test.netflix.net:7002/nodejs-minimal:6.x

RUN time apt-get update                                     && \
         apt-get --no-install-recommends install -y make tar   \
                 gcc g++ wget unzip cmake pkg-config           \
                 libz-dev                                   && \
         apt-get clean                                      && \
         rm -rfv /var/lib/apt/lists/*                       && \
         mkdir /tmp/gflags                                  && \
         cd /tmp/gflags                                     && \
         wget https://github.com/schuhschuh/gflags/archive/master.zip && \
         unzip master.zip                                   && \
         cd gflags-master                                   && \
         mkdir build                                        && \
         cd build                                           && \
         export CXXFLAGS="-fPIC"                            && \
         cmake ..                                           && \
         make VERBOSE=1                                     && \
         make                                               && \
         make install

WORKDIR /apps/grpc

RUN npm config set registry http://artifacts.netflix.com/api/npm/npm-netflix

CMD ["src/node/tools/build/build-tools-linux.sh"]
