// plan: 后处理管线 —— 同义/上下位合并、13 段分桶稳定排序、补人数、按上限裁剪；纯本地、确定性、可单测。
/**
 * lib/postprocess.js — 锻造结果的确定性后处理。
 *
 * 真机锻造暴露的三类毛病，这个文件专门收：
 *   1. 同义 / 上下位叠着来：lying + on_back、from_side + profile、standing + standing_sex、
 *      from_behind + facing_away；
 *   2. 词序乱：镜头词跑到服装词前面，把构图权重抢走；
 *   3. 少人数：白话里明明有「少女」，tag 里却没有 1girl。
 *
 * 处理原则（重要）：**不删用户可能想要的构图信息**。
 *   - 上位词（lying / standing / from_behind / sex…）只降到 0.85，仍留在串里；
 *   - 只有**真同义**（同一个意思的两种写法，如 from_side / profile）才删掉弱的那个。
 *
 * 纯函数：不联网、不调 LLM、不读文件；rows 进、rows 出，同样的输入跑两遍结果一样（幂等）。
 * 不 import lib/purge.js（避免循环依赖），13 段桶表是本地常量，与 purge 的「词序」章节一一对应。
 * 词表已按 lead 核实的真库清单校对：库里没有的词（explicit / nsfw / topless / presenting /
 * face_closeup / doggy_style / young_adult 等）不收进规则表，免得规则自己制造未收录词。
 */

/** 13 段桶表，顺序即词序；与 lib/purge.js「## 词序」的 1–13 段对齐。 */
export const BUCKETS = [
  { key: 'subject', label: '主体与人数' },
  { key: 'character', label: '角色与作品' },
  { key: 'hair', label: '发型与瞳色' },
  { key: 'body', label: '体型与外观' },
  { key: 'expression', label: '表情' },
  { key: 'pose', label: '姿势与动作' },
  { key: 'limbs', label: '肢体关系与手' },
  { key: 'clothing', label: '服装与配饰' },
  { key: 'sexual', label: '性相关细节' },
  { key: 'camera', label: '镜头与构图' },
  { key: 'scene', label: '场景与背景' },
  { key: 'lighting', label: '光照与风格' },
  { key: 'other', label: '其它' },
]

export const BUCKET_INDEX = Object.fromEntries(BUCKETS.map((bucket, index) => [bucket.key, index]))

/**
 * 上下位对：[上位词, 下位词]。两者同时出现时上位词权重降到 0.85（**不删**）。
 * 下位词保留原权重 —— 用户想表达的是「仰卧」，不是笼统的「躺着」。
 */
export const SUPERSET_PAIRS = [
  ['lying', 'on_back'],
  ['lying', 'on_stomach'],
  ['lying', 'on_side'],
  ['sitting', 'seiza'],
  ['sitting', 'wariza'],
  ['standing', 'contrapposto'],
  ['standing', 'standing_sex'],
  // 注意：from_behind / facing_away 曾经也在这里，但这俩不是一个量级 —— 视角词被降到 0.85
  // 会把用户明说的「从正后方拍」压软，所以不降权，两个都留。
  ['nude', 'completely_nude'],
  ['sex', 'vaginal'],
  ['sex', 'anal'],
  ['sex', 'oral'],
  ['sex', 'paizuri'],
  ['sex', 'handjob'],
]

/**
 * 真同义组：组内第一个是留下的（库里更 canonical 的那个），其余全部删掉。
 * 只收「同一个意思的两种写法」，不收「粗细不同」的词 —— 后者走 SUPERSET_PAIRS。
 */
export const SYNONYM_GROUPS = [
  // profile 只描述「侧脸」，与 from_side 的侧面视角重复时会互相打架（真机实测的高频错误）
  ['from_side', 'profile'],
  ['bent_over', 'bending_over'],
  ['squatting', 'crouching'],
  ['kiss', 'kissing'],
]

/** 上位词降到的权重。写成「降到」而不是「乘以」，这样 apply 两遍结果不变。 */
export const SUPERSET_WEIGHT = 0.85

/** 人数词：只要结果里出现任何一个，就说明人数已经被表达过，一律不再补。 */
export const COUNT_WORDS = new Set([
  '1girl', '1boy', '2girls', '2boys', '3girls', '3boys', '4girls', '4boys',
  '5girls', '5boys', '6+girls', '6+boys', 'multiple_girls', 'multiple_boys',
  'multiple_others', '1other', 'solo', 'solo_focus', 'hetero', 'duo', 'couple',
  'male_focus', 'no_humans',
])

const COUNT_RE = /^\d+\+?(girl|boy|other)s?$/

/** 白话里出现这些词就认为「画面里有女性 / 男性」。注意先剔掉「其他 / 其它 / 吉他」里的「他」。 */
const FEMALE_RE = /少女|女孩|女生|女性|妹子|姐姐|妹妹|姑娘|女人|女/
const MALE_RE = /男孩|男生|男性|男人|汉子|哥哥|弟弟|大叔|他|男/
const MALE_FALSE_POSITIVE_RE = /其他|其它|吉他/g

/** 精确桶表：命中即定桶，优先于任何词根规则（这些词靠词根会被分错）。 */
export const EXACT_BUCKET = {
  // 主体与人数
  '1girl': 'subject', '1boy': 'subject', '2girls': 'subject', '2boys': 'subject',
  '3girls': 'subject', '3boys': 'subject', '4girls': 'subject', '4boys': 'subject',
  '5girls': 'subject', '5boys': 'subject', '6+girls': 'subject', '6+boys': 'subject',
  multiple_girls: 'subject', multiple_boys: 'subject', multiple_others: 'subject',
  '1other': 'subject', solo: 'subject', solo_focus: 'subject', hetero: 'subject',
  duo: 'subject', couple: 'subject', male_focus: 'subject',
  no_humans: 'subject',

  // 发型与瞳色
  long_hair: 'hair', short_hair: 'hair', medium_hair: 'hair',
  blonde_hair: 'hair', black_hair: 'hair', brown_hair: 'hair', white_hair: 'hair',
  silver_hair: 'hair', blue_hair: 'hair', pink_hair: 'hair', red_hair: 'hair',
  purple_hair: 'hair', green_hair: 'hair', grey_hair: 'hair', orange_hair: 'hair',
  multicolored_hair: 'hair', gradient_hair: 'hair', twintails: 'hair', ponytail: 'hair',
  side_ponytail: 'hair', braid: 'hair', twin_braids: 'hair', hair_bun: 'hair',
  double_bun: 'hair', bob_cut: 'hair', hime_cut: 'hair', ahoge: 'hair', bangs: 'hair',
  blunt_bangs: 'hair', sidelocks: 'hair', hair_between_eyes: 'hair',
  heterochromia: 'hair', eyelashes: 'hair', eyebrows: 'hair',
  blue_eyes: 'hair', red_eyes: 'hair', green_eyes: 'hair', brown_eyes: 'hair',
  yellow_eyes: 'hair', purple_eyes: 'hair', grey_eyes: 'hair',

  // 表情
  smile: 'expression', smiling: 'expression', seductive_smile: 'expression',
  blush: 'expression', open_mouth: 'expression', closed_mouth: 'expression',
  'closed_eyes': 'expression', one_eye_closed: 'expression', parted_lips: 'expression',
  'half-closed_eyes': 'expression', frown: 'expression', angry: 'expression',
  sad: 'expression', crying: 'expression', tears: 'expression', sweat: 'expression',
  sweatdrop: 'expression', ahegao: 'expression', expressionless: 'expression',
  pout: 'expression', grin: 'expression', smirk: 'expression', laughing: 'expression',
  surprised: 'expression', embarrassed: 'expression', nervous: 'expression',
  scared: 'expression', heart: 'expression', tongue: 'expression',
  tongue_out: 'expression', rolling_eyes: 'expression', clenched_teeth: 'expression',
  heavy_breathing: 'expression', drooling: 'expression', trembling: 'expression',

  // 体型与外观
  breasts: 'body', large_breasts: 'body', medium_breasts: 'body', small_breasts: 'body',
  flat_chest: 'body', cleavage: 'body', navel: 'body', collarbone: 'body',
  thighs: 'body', long_legs: 'body', thick_thighs: 'body', wide_hips: 'body',
  narrow_waist: 'body', skinny: 'body', slim: 'body', muscular: 'body', abs: 'body',
  curvy: 'body', toned: 'body', mature_female: 'body', shiny_skin: 'body',
  loli: 'body', shota: 'body', milf: 'body', bare_shoulders: 'body', sideboob: 'body',
  freckles: 'body', feet: 'body', hands: 'body', pointy_ears: 'body', animal_ears: 'body',
  cat_ears: 'body', fox_ears: 'body', rabbit_ears: 'body', dog_ears: 'body',
  horns: 'body', tail: 'body', cat_tail: 'body', angel_wings: 'body', demon_wings: 'body',
  fang: 'body', mole_under_eye: 'body', testicles: 'body',

  // 姿势与动作
  standing: 'pose', sitting: 'pose', lying: 'pose', on_back: 'pose', on_stomach: 'pose',
  on_side: 'pose', kneeling: 'pose', squatting: 'pose', crouching: 'pose',
  walking: 'pose', running: 'pose', jumping: 'pose', dancing: 'pose',
  leaning_forward: 'pose', arms_up: 'pose', hands_up: 'pose', arms_behind_back: 'pose',
  spread_arms: 'pose', spread_legs: 'pose', dynamic_pose: 'pose', contrapposto: 'pose',
  arched_back: 'pose', bending_over: 'pose', bent_over: 'pose', all_fours: 'pose',
  seiza: 'pose', wariza: 'pose', crossed_legs: 'pose', legs_up: 'pose',
  legs_apart: 'pose', legs_together: 'pose', leg_up: 'pose', knee_up: 'pose',
  on_one_knee: 'pose', sitting_on_lap: 'pose', straddling: 'pose',
  upright_straddle: 'pose', indian_style: 'pose', fetal_position: 'pose',
  head_tilt: 'pose', handstand: 'pose',

  // 肢体关系与手
  hand_on_hip: 'limbs', hands_on_hips: 'limbs', hand_on_breast: 'limbs',
  hand_on_own_breast: 'limbs', hand_on_butt: 'limbs', hand_on_own_cheek: 'limbs',
  hand_on_own_pussy: 'limbs', hand_up: 'limbs',
  crossed_arms: 'limbs', interlocked_fingers: 'limbs', arm_support: 'limbs',
  holding_hands: 'limbs', hugging: 'limbs', covering_face: 'limbs',
  hands_on_own_hips: 'limbs', hug: 'limbs', cupping_breasts: 'limbs', squeezing_own_breasts: 'limbs', grabbing: 'limbs',
  covering_breasts: 'limbs', covering_crotch: 'limbs', hands_on_own_thighs: 'limbs',
  hand_on_own_thigh: 'limbs',

  // 服装与配饰
  dress: 'clothing', skirt: 'clothing', pleated_skirt: 'clothing', shirt: 'clothing',
  blouse: 'clothing', jacket: 'clothing', coat: 'clothing', hoodie: 'clothing',
  sweater: 'clothing', school_uniform: 'clothing', serafuku: 'clothing', kimono: 'clothing',
  yukata: 'clothing', swimsuit: 'clothing', bikini: 'clothing', lingerie: 'clothing',
  panties: 'clothing', bra: 'clothing', thighhighs: 'clothing', pantyhose: 'clothing',
  stockings: 'clothing', socks: 'clothing', barefoot: 'clothing', shoes: 'clothing',
  boots: 'clothing', gloves: 'clothing', hat: 'clothing', glasses: 'clothing',
  sunglasses: 'clothing', earrings: 'clothing', necklace: 'clothing', choker: 'clothing',
  ribbon: 'clothing', bow: 'clothing', hair_bow: 'clothing', hair_ornament: 'clothing',
  hairclip: 'clothing', hairband: 'clothing', hair_ribbon: 'clothing',
  'one-piece_swimsuit': 'clothing', belt: 'clothing', tie: 'clothing', necktie: 'clothing', collar: 'clothing',
  apron: 'clothing', leotard: 'clothing', bodysuit: 'clothing', nightgown: 'clothing',
  negligee: 'clothing', pants: 'clothing', shorts: 'clothing', jeans: 'clothing',
  scarf: 'clothing', garter_belt: 'clothing', 'see-through': 'clothing',
  wet_clothes: 'clothing', partially_covered: 'clothing',

  // 性相关细节
  sex: 'sexual', vaginal: 'sexual', anal: 'sexual', oral: 'sexual', fellatio: 'sexual',
  paizuri: 'sexual', handjob: 'sexual', footjob: 'sexual', masturbation: 'sexual',
  fingering: 'sexual', cunnilingus: 'sexual', missionary: 'sexual',
  doggystyle: 'sexual', cowgirl_position: 'sexual', reverse_cowgirl_position: 'sexual',
  girl_on_top: 'sexual', standing_sex: 'sexual', squatting_sex: 'sexual',
  sex_from_behind: 'sexual', against_wall: 'sexual', penis: 'sexual', pussy: 'sexual',
  vagina: 'sexual', anus: 'sexual', clitoris: 'sexual', precum: 'sexual',
  cum: 'sexual', cum_in_pussy: 'sexual', cum_in_mouth: 'sexual', cum_overflow: 'sexual',
  cum_on_breasts: 'sexual', cum_on_body: 'sexual', cum_on_hair: 'sexual',
  cum_on_tongue: 'sexual', cum_on_stomach: 'sexual', cum_on_chest: 'sexual',
  cum_string: 'sexual', facial: 'sexual', orgasm: 'sexual', after_orgasm: 'sexual',
  after_sex: 'sexual', nipples: 'sexual', areolae: 'sexual', labia: 'sexual',
  pubic_hair: 'sexual', nude: 'sexual', completely_nude: 'sexual', bottomless: 'sexual',
  spread_pussy: 'sexual', penis_in_pussy: 'sexual', penis_in_ass: 'sexual',
  exposed_breasts: 'sexual', exposed_pussy: 'sexual', sexually_suggestive: 'sexual',
  butt_grab: 'sexual', saliva: 'sexual', foreplay: 'sexual', wet: 'sexual', steam: 'sexual',

  // 镜头与构图
  'close-up': 'camera', from_side: 'camera', from_behind: 'camera', from_above: 'camera',
  from_below: 'camera', pov: 'camera', pov_hands: 'camera', looking_at_viewer: 'camera',
  looking_back: 'camera', looking_away: 'camera', looking_up: 'camera', looking_down: 'camera',
  looking_at_another: 'camera', looking_to_the_side: 'camera', eye_contact: 'camera',
  cowboy_shot: 'camera', portrait: 'camera', full_body: 'camera', upper_body: 'camera',
  lower_body: 'camera', profile: 'camera', facing_away: 'camera', facing_viewer: 'camera',
  'top-down_bottom-up': 'camera', "worm's_eye_view": 'camera',
  over_shoulder: 'camera', dutch_angle: 'camera', depth_of_field: 'camera',
  blurry_background: 'camera', simple_background: 'camera', white_background: 'camera',
  transparent_background: 'camera', gradient_background: 'camera', wide_shot: 'camera',
  medium_shot: 'camera', feet_out_of_frame: 'camera', head_out_of_frame: 'camera',
  fisheye: 'camera', symmetry: 'camera', letterboxed: 'camera',

  // 场景与背景
  scenery: 'scene', outdoors: 'scene', indoors: 'scene', sky: 'scene', cloud: 'scene',
  blue_sky: 'scene', sunset: 'scene', night: 'scene', day: 'scene', starry_sky: 'scene',
  rain: 'scene', snow: 'scene', water: 'scene', ocean: 'scene', beach: 'scene',
  forest: 'scene', mountain: 'scene', flower: 'scene', cherry_blossoms: 'scene',
  grass: 'scene', tree: 'scene', city: 'scene', cityscape: 'scene', street: 'scene',
  room: 'scene', bedroom: 'scene', bathroom: 'scene', kitchen: 'scene',
  classroom: 'scene', bed: 'scene', on_bed: 'scene', chair: 'scene', couch: 'scene', sofa: 'scene', table: 'scene',
  window: 'scene', curtain: 'scene', pillow: 'scene', blanket: 'scene', mirror: 'scene',
  door: 'scene', wall: 'scene', floor: 'scene', wooden_floor: 'scene', tile_floor: 'scene',
  pool: 'scene', onsen: 'scene', library: 'scene', rooftop: 'scene', train: 'scene',
  car: 'scene', landscape: 'scene', ruins: 'scene',

  // 光照与风格
  sunlight: 'lighting', moonlight: 'lighting', backlighting: 'lighting', rim_light: 'lighting',
  cinematic_lighting: 'lighting', soft_lighting: 'lighting', dramatic_lighting: 'lighting',
  volumetric_lighting: 'lighting', lens_flare: 'lighting', glowing: 'lighting',
  sparkle: 'lighting', monochrome: 'lighting', greyscale: 'lighting', sepia: 'lighting',
  pastel_colors: 'lighting', vibrant_colors: 'lighting', 'watercolor_(medium)': 'lighting',
  'oil_painting_(medium)': 'lighting', sketch: 'lighting', lineart: 'lighting',
  '3d': 'lighting', photorealistic: 'lighting', chibi: 'lighting', realistic: 'lighting',
  high_contrast: 'lighting', motion_blur: 'lighting', chromatic_aberration: 'lighting',
  film_grain: 'lighting', vignetting: 'lighting',

  // 其它：画质 / 后期 / 文字类，一律排最后
  'best_quality': 'other', 'good_quality': 'other', 'normal_quality': 'other',
  'worst_quality': 'other', 'low_quality': 'other', lowres: 'other', highres: 'other',
  absurdres: 'other', 'jpeg_artifacts': 'other', blurry: 'other', bad_anatomy: 'other',
  bad_hands: 'other', bad_proportions: 'other', extra_digits: 'other',
  fewer_digits: 'other', missing_fingers: 'other', extra_limbs: 'other', bad_feet: 'other',
  text: 'other', watermark: 'other', signature: 'other', username: 'other', logo: 'other',
  english_text: 'other', chinese_text: 'other', speech_bubble: 'other', border: 'other',
  frame: 'other', censored: 'other', bar_censor: 'other', mosaic_censoring: 'other',
  uncensored: 'other',
}


/**
 * 词根规则：精确表没命中时按顺序试；**顺序即优先级**，别随便插。
 * 全部用小写、无空格、无转义的正则字面量，方便一眼看出谁先谁后。
 */
export const TOKEN_RULES = [
  // 角色与作品：带括号后缀的一律是角色 / 作品 / 画师名
  [/[(].+[)]$/, 'character'],
  [/^cosplay/, 'character'],
  [/^(series|artist|character)_/, 'character'],

  // 发型与瞳色
  [/_hair$|^hair|hair_|_eyes$|^eyes$|eye_color|bangs|twintails|ponytail|braid|ahoge|sidelocks|eyebrow|eyelash|heterochromia/, 'hair'],

  // 服装与配饰
  [/dress|skirt|shirt|sweater|jacket|coat$|hoodie|uniform|kimono|yukata|swimsuit|bikini|lingerie|panties|_bra$|^bra_|thighhigh|pantyhose|stocking|_socks?$|_shoes?$|boots|glove|_hat$|glasses|earring|necklace|choker|ribbon|_bow$|^bow_|belt|apron|leotard|bodysuit|cloth|outfit|costume|collar|_tie$|scarf|_pants$|shorts|jeans|barefoot|jewelry|ornament|hairclip|hairband|veil|crown|_mask$|corset|garter/, 'clothing'],

  // 性相关
  [/sex|penis|pussy|vagina|anus|clitor|nipple|areola|_cum|cum_|semen|orgasm|nude|naked|paizuri|handjob|footjob|fellatio|masturbat|fingering|cunnilingus|saliva|foreplay|aroused|lewd|suggestive|butt_grab|anatomically_correct/, 'sexual'],

  // 镜头与构图
  [/^from_|_view$|viewer|_angle|_shot$|^shot_|^close|portrait|framing|^pov|cropped|out_of_frame|composition|_focus|depth_of_field|blurry_background|perspective|^over_shoulder/, 'camera'],

  // 场景与背景
  [/background|outdoors|indoors|_sky$|^sky_|night$|^night_|_day$|room$|_bed$|^on_bed|chair|couch|sofa|window|curtain|pillow|blanket|floor|_wall$|^wall_|door$|street|cityscape|^city|forest|mountain|ocean|beach|water|rain|snow|flower|tree|grass|classroom|library|rooftop|train|_car$|pool|onsen|scenery|landscape|ruins|furniture/, 'scene'],

  // 光照与风格
  [/light|shadow|glow|blur|flare|_effect|monochrome|greyscale|sepia|_color|palette|_style|painting|sketch|lineart|realistic|cinematic|_render|_photo|gradient|pastel/, 'lighting'],

  // 肢体关系与手
  [/hand_.*|hands_.*|_hand$|_hands$|fingers?|^arm|_arm$|_arms$|^hug|_hug$|hugging|grabbing|holding|covering_|cupping|squeezing|_support$|interlocked/, 'limbs'],

  // 表情
  [/smil|blush|mouth|lips|frown|tears?$|crying|sweat|ahegao|expression|pout|grin|smirk|laugh|surprised|embarrass|nervous|scared|angry|sad$|teeth|tongue|drool|trembl|breathing|half-closed|rolling_eyes/, 'expression'],

  // 姿势与动作
  [/standing|sitting|kneel|lying|squat|crouch|bend|lean|arch|spread|straddl|_pose$|^pose_|position|walk|run$|jump|danc|^leg|_leg$|_legs$|knee|^sit|^lie_|^stand/, 'pose'],

  // 体型与外观
  [/breast|chest|thigh|hip|waist|navel|skin|muscular|slim|_abs$|body|figure|shoulder|freckle|ears?$|horns?$|tail$|wings?$|fang|mole|scar|tattoo/, 'body'],

  // 主体与人数
  [/^[0-9]+[+]?(girl|boy|other)s?$|^multiple_|^solo|^hetero|^duo|^couple|no_humans/, 'subject'],

  // 画质 / 后期 / 文字（排最后）
  [/quality|res$|resolution|artifact|^bad_|censored|text$|^text_|watermark|signature|_logo|bubble|border|^frame|username/, 'other'],
]

/** 权重保留两位小数，避免浮点噪声进 prompt。 */
export function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

/** 权重夹到 0.1–2.5（与 lib/forge.js 的 keep() 一致）。 */
export function clampWeight(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 1
  if (num < 0.1) return 0.1
  if (num > 2.5) return 2.5
  return round2(num)
}

/** tag 规范化：去权重后缀、去括号、小写、空格转下划线、压缩下划线。 */
export function normTag(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  // 先剥括号：外层括号把权重后缀包住了，(tag:1.2) 要靠这一步才能露出冒号
  for (let guard = 0; guard < 3; guard += 1) {
    if (text.length > 1 && text[0] === '(' && text[text.length - 1] === ')') text = text.slice(1, -1).trim()
    else break
  }
  // 冒号权重后缀：tag:1.2 / tag::0.8
  const weightMatch = /^(.+?):+:?(-?[0-9]+([.][0-9]+)?)$/.exec(text)
  if (weightMatch) text = weightMatch[1]
  // 反斜杠转义的括号还原（name_\(series\) -> name_(series)）
  text = text.split('\\').join('')
  text = text.toLowerCase()
  text = text.split(' ').join('_')
  text = text.replace(/_+/g, '_')
  text = text.replace(/^_+/, '').replace(/_+$/, '')
  text = text.replace(/^,+|,+$/g, '')
  // 纯数字不是 Danbooru 词（权重残渣 / 噪声），直接判空
  if (/^[0-9]+$/.test(text)) return ''
  return text
}

/** prompt 里的括号必须转义，否则会被当成权重语法。 */
export function escapeParens(text) {
  return String(text == null ? '' : text).split('(').join('\\(').split(')').join('\\)')
}

/** 单行解析：字符串或对象都收，统一成行对象。 */
export function parseRow(input) {
  if (input == null) return null
  if (typeof input === 'string' || typeof input === 'number') {
    const tag = normTag(input)
    if (!tag) return null
    const weightMatch = /^(.+?):(-?[0-9]+([.][0-9]+)?)$/.exec(String(input).trim())
    const weight = weightMatch ? clampWeight(weightMatch[2]) : 1
    return { tag, weight }
  }
  if (typeof input !== 'object') return null
  const rawTag = input.tag != null ? input.tag : input.raw
  const tag = normTag(rawTag)
  if (!tag) return null
  const weightMatch = /^(.+?):(-?[0-9]+([.][0-9]+)?)$/.exec(String(rawTag == null ? '' : rawTag).trim())
  const weight = clampWeight(input.weight != null ? input.weight : (weightMatch ? weightMatch[2] : 1))
  const row = { tag, weight }
  if (input.kind != null) row.kind = input.kind
  if (input.cn != null && input.cn !== '') row.cn = input.cn
  if (typeof input.matched === 'boolean') row.matched = input.matched
  if (input.source != null) row.source = input.source
  return row
}

/** 桶归类：精确表 -> 词根规则 -> other。 */
export function classifyBucket(tag) {
  const key = normTag(tag)
  if (!key) return 'other'
  if (Object.prototype.hasOwnProperty.call(EXACT_BUCKET, key)) return EXACT_BUCKET[key]
  for (const [re, bucket] of TOKEN_RULES) {
    if (re.test(key)) return bucket
  }
  return 'other'
}

/** 桶的中文名，报告里用。 */
export function bucketLabel(key) {
  const found = BUCKETS.find(function (bucket) { return bucket.key === key })
  return found ? found.label : key
}

/** 行规范化：吞字符串 / 对象，丢掉空行与明确 unmatched 的行。 */
export function normalizeRows(input) {
  const list = Array.isArray(input) ? input : []
  const rows = []
  const changes = []
  for (const item of list) {
    const row = parseRow(item)
    if (!row) continue
    // matched === false 表示锻造阶段就没在库里命中；留着只会污染 prompt
    if (row.matched === false) {
      changes.push({ kind: 'dedupe', tag: row.tag, reason: 'unmatched', detail: 'not-in-library' })
      continue
    }
    rows.push(row)
  }
  return { rows, changes }
}

/** 同 tag 去重：保留最大权重，顺带补 cn。 */
export function dedupeRows(rows) {
  const seen = new Map()
  const out = []
  const changes = []
  for (const row of rows) {
    const prev = seen.get(row.tag)
    if (!prev) {
      seen.set(row.tag, row)
      out.push(row)
      continue
    }
    const weight = Math.max(prev.weight, row.weight)
    changes.push({ kind: 'dedupe', tag: row.tag, reason: 'duplicate', weight: round2(weight) })
    if (weight > prev.weight) prev.weight = weight
    if (!prev.cn && row.cn) prev.cn = row.cn
  }
  return { rows: out, changes }
}

/**
 * 上下位合并 + 真同义去重。
 * 上位词只降权到 SUPERSET_WEIGHT（用 min 不用乘法，跑两遍不会再掉），下位词原样留下。
 */
export function mergeSupersets(rows) {
  const byTag = new Map()
  for (const row of rows) byTag.set(row.tag, row)
  const changes = []
  const removed = new Set()

  for (const pair of SUPERSET_PAIRS) {
    const general = byTag.get(pair[0])
    const specific = byTag.get(pair[1])
    if (!general || !specific) continue
    const target = round2(Math.min(general.weight, SUPERSET_WEIGHT))
    if (target < general.weight) {
      changes.push({
        kind: 'superset',
        tag: general.tag,
        reason: 'general-term',
        detail: specific.tag,
        weight: target,
      })
      general.weight = target
    }
  }

  for (const group of SYNONYM_GROUPS) {
    const keeperTag = group[0]
    const keeper = byTag.get(keeperTag)
    for (let i = 1; i < group.length; i++) {
      const dup = byTag.get(group[i])
      if (!dup || removed.has(dup.tag)) continue
      if (keeper) {
        keeper.weight = Math.max(keeper.weight, dup.weight)
        if (!keeper.cn && dup.cn) keeper.cn = dup.cn
      }
      removed.add(dup.tag)
      changes.push({ kind: 'dedupe', tag: dup.tag, reason: 'synonym', detail: keeperTag })
    }
  }

  if (!removed.size) return { rows, changes }
  return { rows: rows.filter(function (row) { return !removed.has(row.tag) }), changes }
}

/** 从白话里读性别与「多人」线索。先剔掉「其他 / 其它 / 吉他」里的「他」，免得误判成男性。 */
export function detectGender(described) {
  const text = String(described == null ? '' : described)
  if (!text.trim()) return { female: false, male: false, multiple: false }
  const maleText = text.replace(MALE_FALSE_POSITIVE_RE, '')
  return {
    female: FEMALE_RE.test(text),
    male: MALE_RE.test(maleText),
    multiple: /两个|两位|俩人|三人|三个|四位|多人|一群|双人|情侣|群像|多女|多男/.test(text),
  }
}

/**
 * 补人数：只补 1girl / 1boy，且只在「一个人数词都没有」时补。
 * 出现 hetero / 2girls / multiple / solo 等任何人数词一律不动 —— 人数已经被表达过，
 * 再塞一个 1girl 就会和自己打架（真机事故就是这么来的）。
 */
export function fillSubject(rows, described, options) {
  const config = options || {}
  const changes = []
  const hasCount = rows.some(function (row) {
    return COUNT_WORDS.has(row.tag) || COUNT_RE.test(row.tag)
  })
  if (hasCount) return { rows, changes, skipped: 'count-present' }

  const explicit = config.subject == null ? '' : String(config.subject)
  const genders = detectGender(described)
  const wanted = []
  if (explicit) {
    for (const part of explicit.split(/[,，\s]+/)) {
      const tag = normTag(part)
      if (tag) wanted.push(tag)
    }
  } else if (genders.multiple) {
    return { rows, changes, skipped: 'multiple' }
  } else {
    if (genders.female) wanted.push('1girl')
    if (genders.male) wanted.push('1boy')
  }
  if (!wanted.length) return { rows, changes, skipped: 'no-cue' }

  const filled = []
  for (const tag of wanted) {
    const row = { tag, weight: 1.2, kind: 'count', source: 'fill' }
    filled.push(row)
    changes.push({
      kind: 'fill',
      tag,
      reason: explicit ? 'explicit' : 'gender-cue',
      detail: explicit || described || '',
    })
  }
  return { rows: filled.concat(rows), changes, skipped: null }
}

/** 13 段稳定排序：同段内保持原顺序，服装必然排在镜头之前。 */
export function orderRows(rows) {
  const decorated = rows.map(function (row, index) {
    return { row, index, bucket: BUCKET_INDEX[classifyBucket(row.tag)] }
  })
  decorated.sort(function (a, b) {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket
    return a.index - b.index
  })
  const out = decorated.map(function (item) { return item.row })
  const changes = []
  const before = rows.map(function (row) { return row.tag }).join(',')
  const after = out.map(function (row) { return row.tag }).join(',')
  if (before !== after) {
    const counts = {}
    for (const item of decorated) {
      const key = BUCKETS[item.bucket].key
      counts[key] = (counts[key] || 0) + 1
    }
    changes.push({ kind: 'order', tag: '', reason: 'bucket-order', detail: after })
    changes.push({ kind: 'buckets', tag: '', reason: 'summary', counts })
  }
  return { rows: out, changes }
}

/** 超上限裁剪：按（段优先, 权重降序, 原序）挑，留下原相对顺序。 */
export function trimRows(rows, maxTags) {
  const limit = Number(maxTags)
  if (!Number.isFinite(limit) || limit <= 0 || rows.length <= limit) return { rows, changes: [] }
  const ranked = rows.map(function (row, index) {
    return { row, index, bucket: BUCKET_INDEX[classifyBucket(row.tag)] }
  })
  ranked.sort(function (a, b) {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket
    if (b.row.weight !== a.row.weight) return b.row.weight - a.row.weight
    return a.index - b.index
  })
  const keep = new Set()
  for (let i = 0; i < limit; i += 1) keep.add(ranked[i].index)
  const out = []
  const changes = []
  rows.forEach(function (row, index) {
    if (keep.has(index)) out.push(row)
    else changes.push({ kind: 'trim', tag: row.tag, reason: 'over-limit', detail: 'maxTags=' + limit })
  })
  return { rows: out, changes }
}

/** 拼成 prompt 串：优先用 tags.formatTagString，失败时落回本地实现（永不抛）。 */
export function formatRows(rows, options) {
  const config = options || {}
  const syntax = config.syntax || 'comfy'
  const tagIndex = config.tags
  if (tagIndex && typeof tagIndex.formatTagString === 'function') {
    try {
      const text = tagIndex.formatTagString(rows, { syntax, standards: config.standards })
      if (typeof text === 'string') return text
    } catch (err) {
      // lib/tags.js 的格式器挂了也不能把整条管线带崩，落回本地实现
    }
  }
  const parts = []
  for (const row of rows) {
    const tag = escapeParens(row.tag)
    if (syntax === 'plain' || row.weight === 1) parts.push(tag)
    else parts.push('(' + tag + ':' + round2(row.weight) + ')')
  }
  return parts.join(', ')
}

/**
 * 造一个后处理器。
 * @param {{ tags?: object, logger?: object, maxTags?: number }} options tags 是 createTagIndex() 的实例，用于格式化
 * @returns {{ apply: Function, classify: Function, detectGender: Function, fillSubject: Function, orderRows: Function, trimRows: Function, format: Function }}
 */
export function createPostProcessor(options) {
  const config = options || {}
  const tags = config.tags || null
  const logger = config.logger || null

  function apply(inputRows, opts) {
    const callOpts = opts || {}
    const changes = []
    const normalized = normalizeRows(inputRows)
    changes.push.apply(changes, normalized.changes)
    let rows = normalized.rows

    const deduped = dedupeRows(rows)
    rows = deduped.rows
    changes.push.apply(changes, deduped.changes)

    const merged = mergeSupersets(rows)
    rows = merged.rows
    changes.push.apply(changes, merged.changes)

    const filled = fillSubject(rows, callOpts.described, { subject: callOpts.subject })
    rows = filled.rows
    changes.push.apply(changes, filled.changes)

    const limit = callOpts.maxTags != null ? callOpts.maxTags : config.maxTags
    const trimmed = trimRows(rows, limit)
    rows = trimmed.rows
    changes.push.apply(changes, trimmed.changes)

    const ordered = orderRows(rows)
    rows = ordered.rows
    changes.push.apply(changes, ordered.changes)

    const positive = formatRows(rows, {
      syntax: callOpts.syntax,
      standards: callOpts.standards,
      tags,
    })

    if (logger && typeof logger.debug === 'function' && changes.length) {
      logger.debug('[postprocess] ' + changes.length + ' change(s): ' + changes.map(function (item) { return item.kind }).join(',') + ' | ' + positive)
    }
    return { rows, changes, positive }
  }

  return {
    apply,
    classify: classifyBucket,
    detectGender,
    fillSubject,
    orderRows,
    trimRows,
    format: formatRows,
    buckets: BUCKETS,
  }
}

export default createPostProcessor
