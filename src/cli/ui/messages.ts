/**
 * 🎨 CLI Personality Messages
 * Because boring is for boomers
 */

export type MessageType =
  | "welcome"
  | "goodbye"
  | "thinking"
  | "success"
  | "error"
  | "warning"
  | "prCreated"
  | "prUpdated"
  | "fetching"
  | "noChanges"
  | "confirmAction";

interface PersonalityMessages {
  [key: string]: string[];
}

export const chaoticMessages: PersonalityMessages = {
  welcome: [
    "🔥 Steve MCP HAS ENTERED THE CHAT! Let's cause some beautiful chaos!",
    "👾 Initializing world domination... I mean, PR automation!",
    "🚀 Buckle up buttercup, we're about to make GitHub our playground!",
    "⚡ *cracks knuckles* Time to automate the shit outta this!",
    "🎮 Player One Ready! Let's push some code and take some names!",
  ],
  goodbye: [
    "✌️ Peace out! Your PRs are in good hands... probably.",
    "🎤 *drops mic* Steve MCP out!",
    "👋 Later, code warrior! May your merges be conflict-free!",
    "🌙 Exiting stage left... dramatically.",
    "💨 And just like that, I vanish into the terminal void...",
  ],
  thinking: [
    "🧠 Big brain time...",
    "🤔 Hmm, let me consult the ancient scrolls of Stack Overflow...",
    "⚙️ Gears turning, neurons firing...",
    "🔮 Gazing into the crystal ball of code...",
    "🧪 Mixing up some developer magic...",
  ],
  success: [
    "🎉 BOOM! Nailed it!",
    "✅ Mission accomplished, chief!",
    "🏆 Another W for the history books!",
    "💪 Too easy! What's next?",
    "🔥 That's what I'm talking about!",
  ],
  error: [
    "💀 Oof, that didn't go as planned...",
    "🙈 Well, that's embarrassing...",
    "❌ Houston, we have a problem...",
    "😅 Okay so... funny story...",
    "🔧 Something broke. Time to pretend it was a feature!",
  ],
  warning: [
    "⚠️ Heads up, chief!",
    "🚨 Alert! This might be important!",
    "👀 You might wanna look at this...",
    "🤨 Hmm, something's a bit sus...",
  ],
  prCreated: [
    "🚀 PR launched into the void! May the reviewers be merciful!",
    "📝 Your PR has been born! It's beautiful! 😭",
    "✨ PR created! Time to @ everyone in Slack!",
    "🎊 New PR who dis? Go check it out!",
    "💫 And on this day, a glorious PR was created!",
  ],
  prUpdated: [
    "📝 PR description updated! It's like poetry now!",
    "✏️ Fresh description, fresh vibes!",
    "🔄 PR got that glow-up!",
    "💅 Looking fresh! Your PR is ready for the runway!",
  ],
  fetching: [
    "🔍 Snooping around GitHub...",
    "📡 Establishing connection to the mothership...",
    "🕵️ Doing some detective work...",
    "🎣 Fishing for data...",
  ],
  noChanges: [
    "🤷 Nothing to see here, move along...",
    "😴 All quiet on the western front...",
    "🦗 *crickets*",
  ],
  confirmAction: [
    "🤔 You sure about this, chief?",
    "👆 Last chance to back out!",
    "⚡ Ready to yeet this into production?",
  ],
};

export const professionalMessages: PersonalityMessages = {
  welcome: [
    "Welcome to Steve MCP. How may I assist you today?",
    "Steve MCP initialized. Ready for operations.",
    "Good to see you. Let's get productive.",
  ],
  goodbye: [
    "Session ended. Have a productive day.",
    "Goodbye. Your changes have been saved.",
    "Until next time.",
  ],
  thinking: ["Processing your request...", "Analyzing...", "Working on it..."],
  success: ["Operation completed successfully.", "Task completed.", "Done."],
  error: [
    "An error occurred. Please check the details below.",
    "Operation failed. See error details.",
    "Unable to complete the request.",
  ],
  warning: [
    "Warning: Please review the following.",
    "Attention required.",
    "Notice:",
  ],
  prCreated: ["Pull request created successfully.", "PR has been opened."],
  prUpdated: [
    "Pull request updated successfully.",
    "PR description has been modified.",
  ],
  fetching: ["Fetching data from GitHub...", "Retrieving information..."],
  noChanges: ["No changes detected.", "Nothing to update."],
  confirmAction: [
    "Please confirm this action.",
    "Are you sure you want to proceed?",
  ],
};

export const zenMessages: PersonalityMessages = {
  welcome: [
    "🧘 Welcome, traveler. The path of clean code awaits...",
    "🌸 Breathe in... breathe out... let's write some PRs.",
    "☯️ In the stillness of the terminal, clarity emerges.",
  ],
  goodbye: [
    "🍃 Go in peace. Your code flows like water.",
    "🌅 Until we meet again on this journey of bytes.",
    "🙏 Namaste, fellow developer.",
  ],
  thinking: [
    "🧘 Contemplating the nature of your request...",
    "🌊 Let the thoughts settle like sand in water...",
    "🌙 Seeking wisdom in the commit history...",
  ],
  success: [
    "🌸 Harmony achieved.",
    "☯️ Balance has been restored.",
    "✨ The universe smiles upon this PR.",
  ],
  error: [
    "🍂 Even the mightiest oak faces storms...",
    "🌧️ A moment of difficulty is but a lesson...",
    "🔥 From ashes, better code will rise.",
  ],
  warning: [
    "🌿 A gentle reminder from the void...",
    "🌊 Turbulence ahead. Proceed mindfully.",
  ],
  prCreated: [
    "🌸 A new PR blooms in the garden of code.",
    "🎋 Your changes flow into the stream of development.",
  ],
  prUpdated: [
    "🌊 The PR evolves, like water shaping stone.",
    "🍃 Change is the only constant. PR updated.",
  ],
  fetching: [
    "🔮 Seeking truth in the GitHub cosmos...",
    "🌌 Reaching across the digital void...",
  ],
  noChanges: ["🍃 Stillness. Nothing stirs.", "☯️ All is as it should be."],
  confirmAction: [
    "🧘 Pause. Reflect. Is this the way?",
    "🌙 Consider carefully before proceeding...",
  ],
};

export function getRandomMessage(
  type: MessageType,
  personality: "professional" | "chaotic" | "zen" = "chaotic",
): string {
  const messages =
    personality === "professional"
      ? professionalMessages
      : personality === "zen"
        ? zenMessages
        : chaoticMessages;

  const messageArray = messages[type] ?? messages["thinking"] ?? [];
  const index = Math.floor(Math.random() * messageArray.length);
  return messageArray[index] ?? "";
}
