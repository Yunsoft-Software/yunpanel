#!/usr/local/bin/node

const prompt = process.argv[2] ?? '';
if (/username/i.test(prompt)) process.stdout.write('x-access-token');
else if (/password/i.test(prompt) && process.env.YUNPANEL_GIT_TOKEN) process.stdout.write(process.env.YUNPANEL_GIT_TOKEN);
else process.exitCode = 1;
