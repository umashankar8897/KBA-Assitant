// Demo KBA data — structured from the four example scenarios.
//
// Step types:
//   action   — analyst performs it and marks it done; recorded under "Checks performed"
//   question — a branching decision; the KBA's outcomeCheck decides resolve vs escalate
//   outcome  — resolve / callback / escalate, optionally with fields to capture
//
// `label` is the short form used in the generated ticket description.

// These are the starting KBAs, used the first time the app runs in a browser.
// Once loaded, the live copy lives in storage (see storage.js) and this file is
// only used again if the user resets.

const DEFAULT_KBAS = [
  {
    id: "kba-till-power",
    title: "Till not powering on",
    keywords: ["till", "power", "screen", "blank", "reboot", "cable", "turn on", "won't turn on"],
    issueExample: "My till is not powering on. We tried to reboot it and checked the power cable, but the screen is completely blank.",
    start: "s1",
    steps: {
      s1: {
        type: "action",
        text: "Check and note the light status on the base unit of the till.",
        label: "Checked base unit light status",
        next: "s2"
      },
      s2: {
        type: "action",
        text: "Power off the till by pressing and holding the button on the base unit.",
        label: "Powered off the till from the base unit",
        next: "s3"
      },
      s3: {
        type: "action",
        text: "Take the cable out of the base unit.",
        label: "Disconnected the cable",
        next: "s4"
      },
      s4: {
        type: "action",
        text: "Press the button on the base unit to defuse the till.",
        label: "Defused the till",
        next: "s5"
      },
      s5: {
        type: "action",
        text: "Reconnect the cable and try to power the till on.",
        label: "Reconnected the cable and tried to power on",
        next: "final"
      },
      final: {
        type: "question",
        text: "Did the till power on?",
        outcomeCheck: true,
        options: [
          { label: "Yes", next: "resolve" },
          { label: "No", next: "escalate" }
        ]
      },
      resolve: { type: "outcome", outcome: "resolve" },
      escalate: {
        type: "outcome",
        outcome: "escalate",
        team: "hardware team",
        captureFields: [
          "Till number",
          "Total number of tills",
          "Base unit light status",
          "Ping status of the till"
        ]
      }
    }
  },
  {
    id: "kba-password-reset",
    title: "Password reset — too many attempts",
    keywords: ["password", "reset", "locked", "too many attempts", "account", "corporate", "login"],
    issueExample: "A corporate user says every time he tries to reset his password it gives an error: too many attempts, try again later.",
    start: "s1",
    steps: {
      s1: {
        type: "question",
        text: "Is the user's account active in QARS?",
        label: "Checked account status in QARS",
        options: [
          { label: "Active", next: "s2" },
          { label: "Disabled", next: "s5" },
          { label: "Locked", next: "s6" }
        ]
      },
      s2: {
        type: "question",
        text: "Has the user tried a password of 14+ characters, mixing upper case, lower case, numbers and special characters?",
        label: "Checked password meets complexity rules",
        options: [
          { label: "Yes", next: "s3" },
          { label: "No", next: "advise" }
        ]
      },
      advise: {
        type: "outcome",
        outcome: "resolve",
        note: "Advised the user on the password requirements."
      },
      s3: {
        type: "question",
        text: "Is the user's manager available now for dual validation?",
        label: "Checked manager availability for dual validation",
        options: [
          { label: "Yes", next: "resolve" },
          { label: "No", next: "callback" }
        ]
      },
      resolve: {
        type: "outcome",
        outcome: "resolve",
        note: "Dual validation completed with the manager. Temporary password shared with the user.",
        captureFields: [
          "Manager name",
          "Manager employee ID",
          "Validation method"
        ]
      },
      callback: {
        type: "outcome",
        outcome: "callback",
        note: "Manager not available. Asked the user to raise a callback form through the HEAT portal. The team will call back to validate and share the password."
      },
      s5: {
        type: "question",
        text: "Is the user's manager available now for dual validation?",
        label: "Checked manager availability for dual validation",
        options: [
          { label: "Yes", next: "escalate-ad" },
          { label: "No", next: "callback" }
        ]
      },
      "escalate-ad": {
        type: "outcome",
        outcome: "escalate",
        team: "Active Directory team",
        note: "Account disabled in QARS. Dual validation completed with the manager.",
        captureFields: [
          "User ID",
          "Manager name",
          "Manager employee ID",
          "Validation method"
        ]
      },
      s6: {
        type: "question",
        text: "Has the user tried resetting the password?",
        label: "Asked the user to try resetting the password",
        options: [
          { label: "Yes, and it worked", next: "resolve-reset" },
          { label: "No, still locked", next: "s3" }
        ]
      },
      "resolve-reset": {
        type: "outcome",
        outcome: "resolve",
        note: "Password reset worked and the account is accessible."
      }
    }
  },
  {
    id: "kba-smartcash-broken",
    title: "Smart cash physically broken",
    keywords: ["smart cash", "broken", "physically", "repair", "damaged"],
    issueExample: "A store user says the smart cash unit is physically broken and needs repair.",
    start: "escalate",
    steps: {
      escalate: {
        type: "outcome",
        outcome: "escalate",
        team: "hardware team",
        captureFields: [
          "Till number the smart cash is attached to",
          "Total number of tills"
        ]
      }
    }
  },
  {
    id: "kba-sales-not-updating",
    title: "Sales not updating on back office",
    keywords: ["sales", "back office", "not updating", "bo", "reporting"],
    issueExample: "A store user says sales have not been updating on the back office since this morning.",
    start: "s1",
    steps: {
      s1: {
        type: "action",
        text: "Check if the logs are running fine.",
        label: "Checked the logs are running",
        next: "s2"
      },
      s2: {
        type: "action",
        text: "Ask for the till number and check the internet connection to that till.",
        label: "Checked internet connection to the till",
        next: "s3"
      },
      s3: {
        type: "action",
        text: "Run the script on the back office while logged in with the engineer profile.",
        label: "Ran the script on the back office",
        next: "s4"
      },
      s4: {
        type: "action",
        text: "Log out of the engineer profile and ask the user to log back in and check.",
        label: "Logged out and asked the user to log back in",
        next: "final"
      },
      final: {
        type: "question",
        text: "Are sales now updating on the back office?",
        outcomeCheck: true,
        options: [
          { label: "Yes", next: "resolve" },
          { label: "No", next: "escalate" }
        ]
      },
      resolve: { type: "outcome", outcome: "resolve" },
      escalate: {
        type: "outcome",
        outcome: "escalate",
        team: "software team",
        captureFields: [
          "Till number",
          "Total number of tills",
          "Time since sales stopped updating",
          "Power cut or internet issue in store"
        ]
      }
    }
  }
];
