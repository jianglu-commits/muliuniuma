const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 12;

const [majorPart = '0', minorPart = '0'] = process.versions.node.split('.');

const major = Number.parseInt(majorPart, 10);
const minor = Number.parseInt(minorPart, 10);

const tooOld =
  major < REQUIRED_MAJOR ||
  (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);

if (tooOld) {
  console.error(
    `需要 Node >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}，当前为 ${process.versions.node}。\n` +
      `请执行：nvm use（不带参数，nvm 会读取仓库根目录的 .nvmrc，使用仓库指定的 Node 版本）`,
  );
  process.exit(1);
}
