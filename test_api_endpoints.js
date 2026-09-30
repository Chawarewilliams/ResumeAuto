const http = require("http");

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on("error", reject);
  });
}

async function test() {
  try {
    const endpoints = [
      "/api/state",
      "/api/candidate-profile",
      "/api/suppression",
      "/api/templates/categorized",
      "/api/resumes/profiles",
      "/api/activity-log",
      "/api/campaign/health",
      "/api/recruiters",
    ];

    console.log("Testing live endpoints...");
    for (const ep of endpoints) {
      try {
        const res = await get(ep);
        console.log(`  ${ep} -> Status: ${res.status} | OK: ${res.body.ok !== false}`);
      } catch (err) {
        console.log(`  ${ep} -> Server not responding or error: ${err.message}`);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

test();
