cmake_minimum_required(VERSION 3.20)
project(OpenGeoEXRPlugin LANGUAGES C CXX)

# Use the matching GDAL sources and their own plugin build rules. No GDAL
# source, exported ABI, driver implementation, or version identifier is patched.
if(NOT IS_DIRECTORY "${GDAL_SOURCE}/frmts/exr")
  message(FATAL_ERROR "GDAL_SOURCE must name the checksum-verified GDAL source tree")
endif()
set(STRICT_VERSION_CHECK ON)
include("${GDAL_SOURCE}/cmake/helpers/SetupStandalonePlugin.cmake")
find_package(OpenEXR 3.4.15 EXACT REQUIRED MODULE)
set(GDAL_ENABLE_DRIVER_EXR ON)
add_subdirectory("${GDAL_SOURCE}/frmts/exr" exr)
target_include_directories(gdal_EXR PRIVATE "${GDAL_SOURCE}/gcore")
set_target_properties(gdal_EXR PROPERTIES
  SKIP_BUILD_RPATH NO
  BUILD_RPATH "/opt/opengeo-openexr/lib"
  INSTALL_RPATH "/opt/opengeo-openexr/lib")
