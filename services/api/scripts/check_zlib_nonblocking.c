/* Exercise EAGAIN using synthetic bytes in a bounded local pipe. */
#include "gzguts.h"
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int descriptors[2];
    unsigned char data[4096] = {0};
    if (pipe(descriptors) != 0) return 2;
    if (fcntl(descriptors[1], F_SETFL, O_NONBLOCK) == -1) return 2;
    size_t filled = 0;
    ssize_t wrote;
    while ((wrote = write(descriptors[1], data, sizeof(data))) > 0) {
        filled += (size_t)wrote;
        if (filled > 1048576) return 2;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK) return 2;
    gzFile file = gzdopen(descriptors[1], "wbT");
    if (!file || gzbuffer(file, 64) != 0) return 2;
    int accepted = gzwrite(file, data, sizeof(data));
    gz_statep state = (gz_statep)file;
    int safe = accepted == 0 && state->again && state->strm.avail_in == 0
        && state->strm.next_in == state->in;
    printf("{\"nonblockingStall\":%s,\"retainedCallerInput\":%s,\"safe\":%s}\n",
        state->again ? "true" : "false",
        state->strm.avail_in ? "true" : "false", safe ? "true" : "false");
    gzclose(file);
    close(descriptors[0]);
    return safe ? 0 : 1;
}
