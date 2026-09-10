cmake_minimum_required(VERSION 3.16)
project(ocafcad LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Debian/Ubuntu ship OCCT without a CMake package config, so fall back to the
# well-known include and library names when find_package comes up empty.
find_package(OpenCASCADE QUIET)

add_library(ocafcad_core
  src/Json.cxx
  src/Schema.cxx
  src/Feature.cxx
  src/Drivers.cxx
  src/Document.cxx
  src/Export.cxx
  src/Server.cxx
)
target_include_directories(ocafcad_core PUBLIC include)

set(OCCT_LIBS
  TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo
  TKPrim TKBO TKFillet TKMesh TKShHealing
  TKCDF TKLCAF TKCAF TKBinL TKBin TKXmlL TKXml
  TKXSBase TKSTEPBase TKSTEP TKSTL
)

if(OpenCASCADE_FOUND)
  target_include_directories(ocafcad_core PUBLIC ${OpenCASCADE_INCLUDE_DIR})
  target_link_directories(ocafcad_core PUBLIC ${OpenCASCADE_LIBRARY_DIR})
else()
  target_include_directories(ocafcad_core PUBLIC /usr/include/opencascade)
endif()
target_link_libraries(ocafcad_core PUBLIC ${OCCT_LIBS})

add_executable(ocafcad src/main.cxx)
target_link_libraries(ocafcad PRIVATE ocafcad_core)

enable_testing()
add_test(NAME demo COMMAND ocafcad demo --tree)
add_test(NAME smoke
         COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/test/run_tests.sh $<TARGET_FILE:ocafcad>
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
