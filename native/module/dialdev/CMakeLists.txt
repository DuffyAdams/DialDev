add_library(dialdev OBJECT dialdev.c)
target_include_directories(dialdev PRIVATE ${PROJECT_SOURCE_DIR}/include ${RE_INCLUDE_DIRS})
