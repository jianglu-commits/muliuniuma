const REQUIRED_MAJOR = 22;

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

if (major < REQUIRED_MAJOR) {
  console.error(
    `需要 Node >= ${REQUIRED_MAJOR}，当前为 ${process.versions.node}。\n` +
      `请执行：nvm use ${REQUIRED_MAJOR}`,
  );
  process.exit(1);
}
