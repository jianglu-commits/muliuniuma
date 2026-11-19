---
name: hello-world
description: 演示 skill：回显用户输入，并演示读取沙箱文件
allowed-tools: [hello-world_echo, sandbox_exec, sandbox_write_file]
---

当用户要求「演示」「打招呼」「回显」时，调用 hello-world_echo 工具回显其输入。

若用户想验证沙箱能力，先用 sandbox_write_file 写入一个文件，
再用 sandbox_exec 执行 `cat` 读取它，把结果如实转述给用户。
