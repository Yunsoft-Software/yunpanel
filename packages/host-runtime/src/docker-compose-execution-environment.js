// Compose variables are supplied by a panel user. They must never change the
// root CLI's daemon, executable search path, credentials, or plugin loader.
const PROCESS_CONTROL_KEY = /^(?:DOCKER_|COMPOSE_|LD_|DYLD_|LC_|NODE_|PYTHON|BASH_ENV$|ENV$|PATH$|HOME$|SHELL$|IFS$|TMPDIR$|LANG$)/;

export function createDockerComposeExecutionEnvironment(environment, { home, projectName, dockerConfig = null }) {
  if (Object.keys(environment).some(key => PROCESS_CONTROL_KEY.test(key))) {
    throw Object.assign(new Error('Docker Compose variables cannot override host process controls'), {
      code: 'docker_compose_environment_invalid',
    });
  }
  return Object.freeze({
    ...environment,
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    DOCKER_CONFIG: dockerConfig ?? home,
    COMPOSE_PROJECT_NAME: projectName,
  });
}
