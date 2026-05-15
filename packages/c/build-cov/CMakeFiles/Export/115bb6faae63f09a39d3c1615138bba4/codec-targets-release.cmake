#----------------------------------------------------------------
# Generated CMake target import file for configuration "Release".
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "codec::codec" for configuration "Release"
set_property(TARGET codec::codec APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(codec::codec PROPERTIES
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libcodec.so.0.2.0"
  IMPORTED_SONAME_RELEASE "libcodec.so.0"
  )

list(APPEND _cmake_import_check_targets codec::codec )
list(APPEND _cmake_import_check_files_for_codec::codec "${_IMPORT_PREFIX}/lib/libcodec.so.0.2.0" )

# Import target "codec::codec_static" for configuration "Release"
set_property(TARGET codec::codec_static APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(codec::codec_static PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "C"
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libcodec.a"
  )

list(APPEND _cmake_import_check_targets codec::codec_static )
list(APPEND _cmake_import_check_files_for_codec::codec_static "${_IMPORT_PREFIX}/lib/libcodec.a" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
