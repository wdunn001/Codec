/* Tiny test harness — keeps tests dependency-free. */
#ifndef CODEC_TEST_H
#define CODEC_TEST_H

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static int _codec_test_failures = 0;

#define CT_FAIL(fmt, ...) do { \
    fprintf(stderr, "  FAIL %s:%d: " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__); \
    _codec_test_failures++; \
} while (0)

#define CT_TRUE(expr) do { \
    if (!(expr)) CT_FAIL("expected true: %s", #expr); \
} while (0)

#define CT_EQ_INT(a, b) do { \
    long long _ax = (long long)(a), _bx = (long long)(b); \
    if (_ax != _bx) CT_FAIL("expected %lld == %lld (%s == %s)", _ax, _bx, #a, #b); \
} while (0)

#define CT_EQ_SZ(a, b) do { \
    size_t _ax = (size_t)(a), _bx = (size_t)(b); \
    if (_ax != _bx) CT_FAIL("expected %zu == %zu (%s == %s)", _ax, _bx, #a, #b); \
} while (0)

#define CT_EQ_STR(a, b) do { \
    const char *_a = (a), *_b = (b); \
    if (!_a || !_b || strcmp(_a, _b) != 0) \
        CT_FAIL("expected %s == %s\n      got: %s\n      want: %s", #a, #b, _a ? _a : "(null)", _b ? _b : "(null)"); \
} while (0)

#define CT_EQ_BYTES(actual, expected, n) do { \
    if (memcmp((actual), (expected), (n)) != 0) { \
        CT_FAIL("byte mismatch (%zu bytes)", (size_t)(n)); \
    } \
} while (0)

#define CT_RUN(fn) do { \
    int before = _codec_test_failures; \
    fn(); \
    int delta = _codec_test_failures - before; \
    fprintf(stdout, "%s %s\n", delta == 0 ? "PASS" : "FAIL", #fn); \
} while (0)

#define CT_DONE() do { \
    if (_codec_test_failures > 0) { \
        fprintf(stderr, "\n%d test failure(s)\n", _codec_test_failures); \
        return 1; \
    } \
    fprintf(stdout, "\nall tests passed\n"); \
    return 0; \
} while (0)

#endif
