# PHP Website removal ordering

An exclusively owned PHP-FPM pool must retire before its Website document root or Unix identity is deleted. Otherwise a subsequent shared FPM reload references the deleted `chdir` directory and can stop unrelated PHP pools and file managers.

The cleanup adapter uses the exact Website/Application/Unix provisioning journal and its durable pool receipt. It verifies pool and socket absence, then retires elFinder and removes canonical files. Unix cleanup repeats these checks so an interrupted operation can resume safely. A pool with missing ownership, retained previous configuration, changed content or a PHP version transition is blocked rather than guessed or removed.

This slice covers unchanged pools created by PHP provisioning. Retirement after PHP settings/version changes, imported pools and PHP sites with database or mail dependencies still requires separate evidence and remains an open lifecycle gate.

SFTP bind mounts and OpenSSH Match rules must retire first, using the exact original receipt. An enabled mount unit can recreate a deleted home directory on reboot. Physical retirement checks configuration, chroot, systemd unit and the actual mount inventory; a compensated receipt alone is insufficient. The key-aware production handler must preserve these retirement methods.
