# vcpkg portfile for libcodec.
#
# To consume from vcpkg before this is merged upstream:
#   1. Place this file at <vcpkg>/ports/codec/portfile.cmake
#   2. Place vcpkg.json alongside it
#   3. vcpkg install codec
#
# Once accepted into microsoft/vcpkg, `vcpkg install codec` works directly.

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO            wdunn001/Codec
    REF             "v${VERSION}"
    SHA512          0  # populated when REF is tagged
    HEAD_REF        main
    PATCHES         ""
)

# The C library lives in packages/c relative to repo root.
set(CODEC_C_DIR "${SOURCE_PATH}/packages/c")

vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        tests   CODEC_BUILD_TESTS
)

string(COMPARE EQUAL "${VCPKG_LIBRARY_LINKAGE}" "static" CODEC_BUILD_STATIC_BOOL)
string(COMPARE EQUAL "${VCPKG_LIBRARY_LINKAGE}" "dynamic" CODEC_BUILD_SHARED_BOOL)

vcpkg_cmake_configure(
    SOURCE_PATH "${CODEC_C_DIR}"
    OPTIONS
        -DCODEC_BUILD_STATIC=${CODEC_BUILD_STATIC_BOOL}
        -DCODEC_BUILD_SHARED=${CODEC_BUILD_SHARED_BOOL}
        -DCODEC_BUILD_EXAMPLES=OFF
        -DCODEC_INSTALL=ON
        ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(PACKAGE_NAME codec)
vcpkg_fixup_pkgconfig()

# Strip duplicates from include / cmake debug copies: vcpkg convention.
file(REMOVE_RECURSE
    "${CURRENT_PACKAGES_DIR}/debug/include"
    "${CURRENT_PACKAGES_DIR}/debug/share"
)

# License + usage handling.
file(INSTALL "${SOURCE_PATH}/LICENSE"
     DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}"
     RENAME copyright)

if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/usage")
    file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage"
         DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
endif()
