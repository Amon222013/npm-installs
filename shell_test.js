const { execSync } = require('child_process');
const { convert } = require('encoding-japanese');
const shell = require('./shellHelper');

function main (){
    const arr = [
        "test1",
        "test2",
        "test3"
    ];
    const stdout = execSync(`sh test.sh ${arr}`);
    console.log(toString(stdout));
}

function toString (bytes) {
    return convert(bytes, {
      from: 'SJIS',
      to: 'UNICODE',
      type: 'string',
    });
};

main();
