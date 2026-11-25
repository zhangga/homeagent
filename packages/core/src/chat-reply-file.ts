import { createHash, randomUUID } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readCaptureFile } from "./chat-document-import.ts";

// im.files.create documents a 30 MB limit and rejects empty files.
const MAX_REPLY_FILE_BYTES = 30 * 1024 * 1024;
export interface ChatReplyFile {
  directory: string;
  name: string;
  size: number;
  digest: string;
  attachToAnswer: boolean;
  agentBindingEpoch?: string;
  fileKey?: string;
  requestPending?: true;
  delivered?: true;
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !/[\\/:\u0000-\u001f\u007f]/u.test(name);
}

export function isChatReplyFile(value: unknown): value is ChatReplyFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ChatReplyFile>;
  return typeof file.directory === "string" && /^\.homeagent-delivery-[a-f0-9-]{36}$/u.test(file.directory)
    && validName(file.name) && typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_REPLY_FILE_BYTES
    && typeof file.digest === "string" && /^[a-f0-9]{64}$/u.test(file.digest) && typeof file.attachToAnswer === "boolean"
    && (file.agentBindingEpoch === undefined || (typeof file.agentBindingEpoch === "string" && file.agentBindingEpoch.length <= 256))
    && (file.fileKey === undefined || (typeof file.fileKey === "string" && /^file_[A-Za-z0-9_-]{1,250}$/u.test(file.fileKey)))
    && (file.requestPending === undefined || (file.requestPending === true && !!file.fileKey && !file.delivered))
    && (file.delivered === undefined || (file.delivered === true && !!file.fileKey));
}

export function replyFileIntent(input: string, chatType?: "p2p" | "group"): "make" | "make-and-send" | "send" | undefined {
  if (chatType === "p2p") input = input.replace(/(?:当前|这个|本)?私聊(?:会话)?/gu, "当前会话");
  const fileObject = /(?:附件|文件|周报|报告|报表|表格|文稿|演示稿|幻灯片|压缩包|文档|pdf|pptx?|docx?|xlsx?|\.[a-z0-9]{1,8}\b)/iu;
  if (!fileObject.test(input)) return undefined;
  // Existing files named in a follow-up are selected only from an actual previous result.
  const prior = /(?:刚刚?|之前|刚才|上一[轮条次]|上次|已经|已)(?:(?:刚刚?)?生成|做|写|输出|完成|保存|制作)|(?:你|上面).{0,8}(?:生成|做|写)的/u.test(input);
  const make = /(?:生成|制作|导出|输出|编写|写(?:一|份|个)|做(?:一|份|个)|整理成|保存[为成])/u.test(input) && !prior;
  const destination = /(?:发(?:送)?|上传|传|投递)(?:到|至|给)?(?:我|本群|群里|当前(?:群|会话|话题)|这里|这个群|原话题|飞书)|(?:发|传)(?:回|出来|过来)|(?:以|作为|用)附件(?:回复|发送|回传)|(?:回传|发送附件)/u.exec(input);
  const clause = destination && input.slice(0, destination.index).split(/[，,。；;\n]|然后|并且|接着|最后|并/u).at(-1)!.trim();
  const separateText = /(?:结论|摘要|要点|说明|反馈|消息|链接|路径|正文|概要|概述|提纲|总结)(?:用文字|原文|内容|即可|直接|也|再)?$/u;
  const send = !!destination && !separateText.test(clause ?? "")
    && (fileObject.test((clause ?? "") + destination[0]) || ((!clause || /^(?:请|直接|顺便|也|再|把它|将其|就|记得)+$/u.test(clause)) && (make || prior)))
    && !/(?:不要|别|不必|无需|不用|禁止).{0,8}(?:发|传|投递)|(?:发(?:送)?|上传|传(?:送)?|投递)(?:给|至|到)(?!我|本群|群里|当前[群会话题]|这里|这个群|原话题|飞书(?:[。！,，\s]|$))/u.test(input)
    && !(chatType === "group" && /(?:私聊|单独).{0,6}(?:发|传)|发(?:送)?到私聊/u.test(input));
  if (send) return make ? "make-and-send" : "send";
  return make ? "make" : undefined;
}

export function namesReplyFile(request: string, name: string, generating = false): boolean {
  // Only an explicit output filename selects the artifact. Input material before
  // "生成" (or after a "根据/使用" clause) must not select the file to deliver.
  let object = request.trim().replace(/^@\S+\s+/u, "");
  if (generating) {
    const use = /(?:命名为|(?:文件名|输出名)(?:为|叫)|保存为|另存为)/u.exec(object)
      ?? /(?:生成|制作|导出|输出|编写|写(?:一|份|个)|做(?:一|份|个)|整理成)/u.exec(object);
    if (use) object = object.slice(use.index + use[0].length);
    object = object.split(/(?:根据|基于|参考|读取|使用|用到|输入文件)/u, 1)[0]!;
  }
  const names: string[] = [];
  for (const match of object.matchAll(/[`“「"]([^`”」"\n]+?\.[a-z][a-z0-9]{0,9})[`”」"]|([\p{L}\p{N}_+()@.-]+\.[a-z][a-z0-9]{0,9})\b/giu)) {
    const literal = match[1] ?? match[2]!.replace(/^(?:(?:请|帮我|把|将|刚才生成的|刚刚生成的|刚生成的|已经生成的|刚做好的|上次生成的|上一轮生成的|一份|一个|名为|附件名为|要发送的|这个文件|这份文件))+/u, "");
    names.push(literal.normalize("NFC").toLowerCase());
  }
  return names.length === 0 || names.includes(name.normalize("NFC").toLowerCase());
}

export function prepareReplyFile(workdir: string, request: string, attachToAnswer: boolean, agentBindingEpoch?: string) {
  const directory = `.homeagent-delivery-${randomUUID()}`;
  const path = join(workdir, directory);
  return {
    instruction: [
      "## 本轮最终文件交付",
      `若本轮实际生成了用户点名的最终文件，请保留用户指定的保存位置，同时在专属目录 ${JSON.stringify(path)} 中放入这个最终文件的完整副本，使用用户可识别的文件名。目录按需创建，只放本轮最终文件，不放内部查询交接、凭据或其他资料。`,
      "正常回答并保留用户可用的原保存路径。用户只要文字时不必创建文件。本机服务核实文件后按用户要求投递，请勿自行调用飞书上传/发送工具、声称附件已送达或在回答里暴露专属目录。",
    ].join("\n"),
    finish(): ChatReplyFile | undefined {
      try {
        if (realpathSync(workdir) !== workdir || realpathSync(path) !== path || !lstatSync(path).isDirectory()) return undefined;
        const dir = opendirSync(path);
        let name: string;
        try {
          const candidate = dir.readSync();
          if (!candidate?.isFile() || !validName(candidate.name) || !namesReplyFile(request, candidate.name, true) || dir.readSync()) return undefined;
          name = candidate.name;
        } finally { dir.closeSync(); }
        const { bytes } = readCaptureFile(workdir, join(directory, name), MAX_REPLY_FILE_BYTES);
        if (!bytes.length) return undefined;
        return { directory, name, size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), attachToAnswer, agentBindingEpoch };
      } catch { return undefined; }
    },
  };
}

export function frozenReplyFileBytes(workdir: string, file: ChatReplyFile): Uint8Array {
  if (!isChatReplyFile(file)) throw new Error("交付文件记录无效。");
  const { bytes } = readCaptureFile(workdir, join(file.directory, file.name), file.size);
  if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error("交付文件已变更。");
  return bytes;
}
