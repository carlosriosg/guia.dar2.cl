<?php
// proxy.php — proxy CORS + auth para guia.dar2.cl
// Sube este archivo a la raíz del sitio (junto a index.html). Bluehost trae
// PHP y cURL habilitados por defecto.
//
// MODOS DE USO:
//   1. ?u=BASE64URL              → proxy CORS para feeds RSS (whitelist, sin auth)
//   2. ?action=hash&p=PASSWORD   → genera bcrypt hash (utilidad para crear users)
//   3. POST ?action=login        → body JSON {username,password} → devuelve {token}
//   4. ?action=lists&token=...   → devuelve private/lists.json
//   5. ?action=m3u&id=X&token=...→ fetchea M3U y devuelve canales parseados
//   6. ?action=debug&token=...   → diagnóstico (borrar después de validar)
//
// AUTH: tokens HMAC-SHA256 firmados con secret en private/.secret (autogen).
// Validez: 8 horas. El secret es estable hasta que se borre el archivo.

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$action = isset($_GET['action']) ? $_GET['action'] : '';

// ─── Acción: bootstrap ──────────────────────────────────────────────────
// Import inicial sin auth — solo funciona si no existe ningún user con
// role:'admin' en users.json. Permite restaurar desde un JSON de backup
// cuando perdiste las credenciales o estás haciendo una instalación fresh.
// Una vez que hay al menos un admin, el endpoint queda bloqueado y hay que
// usar el panel admin (con auth) para importar.
if ($action === 'bootstrap') {
    $usersFile = __DIR__ . '/private/users.json';
    $existing = is_file($usersFile)
        ? json_decode(file_get_contents($usersFile), true)
        : ['users' => []];
    $hasAdmin = false;
    if (isset($existing['users']) && is_array($existing['users'])) {
        foreach ($existing['users'] as $u) {
            if (isset($u['role']) && $u['role'] === 'admin'
                && isset($u['password_hash']) && !empty($u['password_hash'])
                && strpos($u['password_hash'], 'REEMPLAZAR') === false) {
                $hasAdmin = true; break;
            }
        }
    }
    if ($hasAdmin) {
        http_response_code(403);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Bootstrap bloqueado: ya hay un admin configurado. Iniciá sesión y usá Importar desde el panel admin.']));
    }
    $body = read_json_body();
    if (!is_array($body)) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Body inválido — debe ser JSON']));
    }
    if ((!isset($body['users']) || !is_array($body['users']) || count($body['users']) === 0)) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'El JSON debe contener al menos 1 usuario en "users"']));
    }
    // Validar que haya al menos 1 admin en el import
    $importHasAdmin = false;
    foreach ($body['users'] as $u) {
        if (!isset($u['username'], $u['password_hash'])) {
            http_response_code(400);
            header('Content-Type: application/json');
            exit(json_encode(['error' => 'Algún usuario del JSON no tiene username o password_hash']));
        }
        if (isset($u['role']) && $u['role'] === 'admin') $importHasAdmin = true;
    }
    if (!$importHasAdmin) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'El JSON debe contener al menos 1 usuario con role:"admin"']));
    }
    $report = ['ok' => true];
    if (!_write_json_file($usersFile, ['users' => $body['users']])) {
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'No se pudo escribir users.json (chequeá permisos de private/)']));
    }
    $report['users_imported'] = count($body['users']);
    if (isset($body['lists']) && is_array($body['lists'])) {
        if (!_write_json_file(__DIR__ . '/private/lists.json', ['lists' => $body['lists']])) {
            http_response_code(500);
            header('Content-Type: application/json');
            exit(json_encode(['error' => 'No se pudo escribir lists.json']));
        }
        $report['lists_imported'] = count($body['lists']);
    }
    header('Content-Type: application/json');
    echo json_encode($report);
    exit;
}

// ─── Acción: hash bcrypt ────────────────────────────────────────────────
// Utilidad para generar el password_hash que va en private/users.json.
// Uso: visita /proxy.php?action=hash&p=tupassword y copia la salida.
if ($action === 'hash') {
    $pass = isset($_GET['p']) ? $_GET['p'] : '';
    if (!$pass) { http_response_code(400); exit('Missing p parameter'); }
    header('Content-Type: text/plain; charset=utf-8');
    echo password_hash($pass, PASSWORD_BCRYPT);
    exit;
}

// ─── Helpers de tokens ──────────────────────────────────────────────────
// El secret se autogenera la primera vez (32 bytes random hex). Vive en
// private/.secret (bloqueado por .htaccess Deny from all). Si se borra,
// los tokens emitidos quedan inválidos y todos los users deben re-loguear.
function get_secret() {
    $f = __DIR__ . '/private/.secret';
    if (!is_file($f)) {
        $secret = bin2hex(random_bytes(32));
        @file_put_contents($f, $secret);
        @chmod($f, 0600);
        return $secret;
    }
    return trim(file_get_contents($f));
}

function b64url_encode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}
function b64url_decode($data) {
    $rem = strlen($data) % 4;
    if ($rem) $data .= str_repeat('=', 4 - $rem);
    return base64_decode(strtr($data, '-_', '+/'));
}

function make_token($user, $hours = 8) {
    $payload = [
        'u'   => $user['username'],
        'n'   => isset($user['name']) ? $user['name'] : $user['username'],
        'r'   => isset($user['role']) ? $user['role'] : 'user',
        'exp' => time() + $hours * 3600,
    ];
    $headerB64 = b64url_encode(json_encode($payload, JSON_UNESCAPED_UNICODE));
    $sig = hash_hmac('sha256', $headerB64, get_secret(), true);
    return $headerB64 . '.' . b64url_encode($sig);
}

function verify_token($token) {
    if (!$token || strpos($token, '.') === false) return null;
    $parts = explode('.', $token, 2);
    if (count($parts) !== 2) return null;
    list($headerB64, $sigB64) = $parts;
    $expected = hash_hmac('sha256', $headerB64, get_secret(), true);
    $given = b64url_decode($sigB64);
    if (!$given || !hash_equals($expected, $given)) return null;
    $payload = json_decode(b64url_decode($headerB64), true);
    if (!is_array($payload) || !isset($payload['exp']) || $payload['exp'] < time()) return null;
    return $payload;
}

function require_token() {
    $token = isset($_GET['token']) ? $_GET['token'] : '';
    $payload = verify_token($token);
    if (!$payload) {
        http_response_code(401);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Invalid or expired token']));
    }
    return $payload;
}

// ─── Lectura del body JSON (para POST login) ────────────────────────────
function read_json_body() {
    $raw = file_get_contents('php://input');
    if (!$raw) return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

// ─── Acción: login ──────────────────────────────────────────────────────
if ($action === 'login') {
    $data = read_json_body();
    if (!$data || !isset($data['username'], $data['password'])) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Missing username or password in JSON body']));
    }

    $usersFile = __DIR__ . '/private/users.json';
    if (!is_file($usersFile)) {
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'users.json not found']));
    }
    $users = json_decode(file_get_contents($usersFile), true);
    if (!isset($users['users']) || !is_array($users['users'])) {
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Invalid users.json']));
    }

    foreach ($users['users'] as $u) {
        if (!isset($u['username'], $u['password_hash'])) continue;
        // username case-insensitive, password case-sensitive (estándar).
        if (strcasecmp($u['username'], $data['username']) === 0
            && password_verify($data['password'], $u['password_hash'])) {
            $token = make_token($u);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode([
                'token' => $token,
                'user'  => [
                    'username' => $u['username'],
                    'name'     => isset($u['name']) ? $u['name'] : $u['username'],
                    'role'     => isset($u['role']) ? $u['role'] : 'user',
                ],
                'expires_in' => 8 * 3600,
            ]);
            exit;
        }
    }

    // Pequeña espera aleatoria para mitigar timing/brute-force.
    usleep(rand(200000, 600000));
    http_response_code(401);
    header('Content-Type: application/json');
    exit(json_encode(['error' => 'Invalid credentials']));
}

// ─── Acción: debug ──────────────────────────────────────────────────────
// Diagnóstico. Si pasás token, valida; si no, muestra info del server.
// Borrá este bloque después de confirmar que todo funcione.
if ($action === 'debug') {
    header('Content-Type: application/json; charset=utf-8');
    $token = isset($_GET['token']) ? $_GET['token'] : '';
    $payload = $token ? verify_token($token) : null;
    $usersFile = __DIR__ . '/private/users.json';

    // Test outbound HTTPS (necesario para fetch RSS y streams)
    $outbound = ['ok' => false, 'http_code' => 0, 'error' => null];
    if (function_exists('curl_init')) {
        $ch = curl_init('https://news.google.com/');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_NOBODY         => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        curl_exec($ch);
        $outbound['http_code'] = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $outbound['error'] = curl_error($ch) ?: null;
        $outbound['ok'] = $outbound['http_code'] > 0;
        curl_close($ch);
    }

    $info = [
        'php_version'         => phpversion(),
        'sapi'                => php_sapi_name(),
        'request_method'      => $_SERVER['REQUEST_METHOD'],
        // Extensiones críticas
        'curl_extension'      => extension_loaded('curl'),
        'curl_version'        => function_exists('curl_version') ? curl_version()['version'] : null,
        'openssl_extension'   => extension_loaded('openssl'),
        // Conectividad
        'outbound_https'      => $outbound,
        // Archivos privados
        'users_file_exists'   => is_file($usersFile),
        'users_file_readable' => is_readable($usersFile),
        'lists_file_exists'   => is_file(__DIR__ . '/private/lists.json'),
        'secret_file_exists'  => is_file(__DIR__ . '/private/.secret'),
        'private_dir_exists'  => is_dir(__DIR__ . '/private'),
        'secret_writable_dir' => is_writable(__DIR__ . '/private'),
        // Server info
        'server_software'     => $_SERVER['SERVER_SOFTWARE'] ?? null,
        'document_root'       => $_SERVER['DOCUMENT_ROOT'] ?? null,
        // Token (si lo pasaste)
        'token_provided'      => !!$token,
        'token_valid'         => $payload !== null,
        'token_payload'       => $payload,
    ];
    echo json_encode($info, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// ─── Acción: change_password ────────────────────────────────────────────
// Permite que cualquier user logueado cambie su propia contraseña.
// Requiere current (la actual) para evitar takeover si dejaste la pestaña abierta.
if ($action === 'change_password') {
    $payload = require_token();
    $body = read_json_body();
    if (!$body || !isset($body['current']) || !isset($body['new'])) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Faltan campos: current y new son obligatorios']));
    }
    if (strlen($body['new']) < 4) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'La nueva contraseña debe tener al menos 4 caracteres']));
    }
    if ($body['new'] === $body['current']) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'La nueva contraseña debe ser distinta de la actual']));
    }
    $usersFile = __DIR__ . '/private/users.json';
    if (!is_file($usersFile)) {
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'users.json no encontrado']));
    }
    $data = json_decode(file_get_contents($usersFile), true);
    if (!isset($data['users']) || !is_array($data['users'])) {
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'users.json corrupto']));
    }
    $username = isset($payload['u']) ? $payload['u'] : '';
    $found = false;
    foreach ($data['users'] as &$u) {
        if (!isset($u['username'])) continue;
        if (strcasecmp($u['username'], $username) === 0) {
            // Validar contraseña actual antes de permitir cambio
            if (!isset($u['password_hash']) || !password_verify($body['current'], $u['password_hash'])) {
                http_response_code(401);
                header('Content-Type: application/json');
                exit(json_encode(['error' => 'La contraseña actual es incorrecta']));
            }
            $u['password_hash'] = password_hash($body['new'], PASSWORD_BCRYPT);
            $found = true;
            break;
        }
    }
    unset($u);
    if (!$found) {
        http_response_code(404);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Usuario no encontrado en users.json']));
    }
    if (!_write_json_file($usersFile, $data)) {
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'No se pudo guardar el cambio (chequeá permisos)']));
    }
    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'message' => 'Contraseña actualizada. Tu sesión sigue activa.']);
    exit;
}

// ─── Acción: lists ──────────────────────────────────────────────────────
if ($action === 'lists') {
    require_token();
    $listsFile = __DIR__ . '/private/lists.json';
    header('Content-Type: application/json; charset=utf-8');
    if (!is_file($listsFile)) { echo '{"lists":[]}'; exit; }
    readfile($listsFile);
    exit;
}

// ─── Acción: admin ──────────────────────────────────────────────────────
// Panel de administración: CRUD de usuarios y listas. Solo role:'admin'.
// Ruteo: ?action=admin&type=users|lists&op=list|create|update|delete[&id=X]
// Operaciones de escritura (create/update/delete) requieren POST con body
// JSON. La operación 'list' es GET sin body.
if ($action === 'admin') {
    $payload = require_token();
    if (($payload['r'] ?? 'user') !== 'admin') {
        http_response_code(403);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Admin only']));
    }
    $type = isset($_GET['type']) ? $_GET['type'] : '';
    $op   = isset($_GET['op']) ? $_GET['op'] : 'list';
    if ($type === 'users')        admin_users($op, $payload);
    else if ($type === 'lists')   admin_lists($op);
    else if ($type === 'export')  admin_export($payload);
    else if ($type === 'import')  admin_import($payload);
    else { http_response_code(400); exit(json_encode(['error' => 'Invalid type'])); }
    exit;
}

// Import: reemplaza users.json y/o lists.json con el contenido del JSON
// que llega en POST body. Se valida formato mínimo. Carlos puede usarlo
// como restore desde un backup (o para sincronizar entre 2 instalaciones
// del sitio en distintos hostings).
function admin_import($payload) {
    $body = read_json_body();
    if (!is_array($body)) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'Body inválido — debe ser JSON con users/lists']));
    }
    $report = ['ok' => true];
    if (isset($body['users']) && is_array($body['users'])) {
        // Validar
        foreach ($body['users'] as $u) {
            if (!isset($u['username'], $u['password_hash'])) {
                http_response_code(400);
                header('Content-Type: application/json');
                exit(json_encode(['error' => 'Hay un usuario sin username o password_hash']));
            }
        }
        // No permitir borrarte a vos mismo: si el current user no está en el
        // import, lo agregamos para no bloquear el acceso.
        $current = isset($payload['u']) ? $payload['u'] : '';
        $hasCurrent = false;
        foreach ($body['users'] as $u) {
            if (strcasecmp($u['username'], $current) === 0) { $hasCurrent = true; break; }
        }
        if (!$hasCurrent && $current) {
            // Recuperar al current user del users.json existente
            $existing = is_file(__DIR__ . '/private/users.json')
                ? json_decode(file_get_contents(__DIR__ . '/private/users.json'), true)
                : ['users' => []];
            foreach ($existing['users'] ?? [] as $u) {
                if (isset($u['username']) && strcasecmp($u['username'], $current) === 0) {
                    $body['users'][] = $u;
                    $report['preserved_current_user'] = true;
                    break;
                }
            }
        }
        if (!_write_json_file(__DIR__ . '/private/users.json', ['users' => $body['users']])) {
            http_response_code(500);
            header('Content-Type: application/json');
            exit(json_encode(['error' => 'No se pudo escribir users.json (permisos?)']));
        }
        $report['users_imported'] = count($body['users']);
    }
    if (isset($body['lists']) && is_array($body['lists'])) {
        foreach ($body['lists'] as $l) {
            if (!isset($l['id'], $l['name'], $l['url'])) {
                http_response_code(400);
                header('Content-Type: application/json');
                exit(json_encode(['error' => 'Hay una lista sin id/name/url']));
            }
        }
        if (!_write_json_file(__DIR__ . '/private/lists.json', ['lists' => $body['lists']])) {
            http_response_code(500);
            header('Content-Type: application/json');
            exit(json_encode(['error' => 'No se pudo escribir lists.json']));
        }
        $report['lists_imported'] = count($body['lists']);
    }
    if (!isset($report['users_imported']) && !isset($report['lists_imported'])) {
        http_response_code(400);
        header('Content-Type: application/json');
        exit(json_encode(['error' => 'JSON sin "users" ni "lists" — nada que importar']));
    }
    header('Content-Type: application/json');
    echo json_encode($report);
}

// Export completo: usuarios (con password_hash, no plaintext porque bcrypt
// es one-way) + listas. El JSON puede usarse para migrar a otro server o
// como backup. ⚠️ Contiene secretos — guardalo en lugar seguro.
function admin_export($payload) {
    $usersFile = __DIR__ . '/private/users.json';
    $listsFile = __DIR__ . '/private/lists.json';
    $users = is_file($usersFile) ? json_decode(file_get_contents($usersFile), true) : ['users'=>[]];
    $lists = is_file($listsFile) ? json_decode(file_get_contents($listsFile), true) : ['lists'=>[]];
    $export = [
        'exported_at'   => date('c'),
        'exported_by'   => $payload['u'] ?? '',
        'exported_from' => isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '',
        'note'          => 'Los password_hash son bcrypt one-way: no se pueden recuperar las contraseñas en texto plano. Sí se pueden re-importar en otro server con el mismo schema.',
        'users'         => $users['users'] ?? [],
        'lists'         => $lists['lists'] ?? [],
    ];
    $filename = 'guia-private-export-' . date('Y-m-d') . '.json';
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Cache-Control: no-store');
    echo json_encode($export, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function _read_json_file($path, $defaultKey) {
    if (!is_file($path)) return [$defaultKey => []];
    $data = json_decode(file_get_contents($path), true);
    if (!is_array($data) || !isset($data[$defaultKey]) || !is_array($data[$defaultKey])) {
        return [$defaultKey => []];
    }
    return $data;
}
function _write_json_file($path, $data) {
    $tmp = $path . '.tmp.' . getmypid();
    if (file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
        return false;
    }
    return @rename($tmp, $path);
}

function admin_users($op, $current) {
    $file = __DIR__ . '/private/users.json';
    $data = _read_json_file($file, 'users');
    $users = $data['users'];
    header('Content-Type: application/json; charset=utf-8');

    if ($op === 'list') {
        // Sanitizamos: nunca devolvemos password_hash al cliente.
        $clean = array_map(function($u) {
            return [
                'username' => $u['username'] ?? '',
                'name'     => $u['name'] ?? '',
                'role'     => $u['role'] ?? 'user',
            ];
        }, $users);
        echo json_encode(['users' => $clean]);
        return;
    }

    $body = read_json_body() ?: [];

    if ($op === 'create') {
        $username = trim($body['username'] ?? '');
        $password = $body['password'] ?? '';
        $name     = trim($body['name'] ?? '');
        $role     = ($body['role'] ?? 'user') === 'admin' ? 'admin' : 'user';
        if ($username === '' || $password === '') {
            http_response_code(400);
            exit(json_encode(['error' => 'username y password son obligatorios']));
        }
        foreach ($users as $u) {
            if (isset($u['username']) && strcasecmp($u['username'], $username) === 0) {
                http_response_code(409);
                exit(json_encode(['error' => 'Ya existe un usuario con ese nombre']));
            }
        }
        $users[] = [
            'username'      => $username,
            'password_hash' => password_hash($password, PASSWORD_BCRYPT),
            'name'          => $name !== '' ? $name : $username,
            'role'          => $role,
        ];
        $data['users'] = $users;
        if (!_write_json_file($file, $data)) {
            http_response_code(500);
            exit(json_encode(['error' => 'No se pudo escribir users.json (chequea permisos)']));
        }
        echo json_encode(['ok' => true]);
        return;
    }

    if ($op === 'update') {
        $id = isset($_GET['id']) ? $_GET['id'] : '';
        $found = false;
        foreach ($users as &$u) {
            if (isset($u['username']) && strcasecmp($u['username'], $id) === 0) {
                if (isset($body['name'])) $u['name'] = trim($body['name']);
                if (isset($body['role'])) $u['role'] = $body['role'] === 'admin' ? 'admin' : 'user';
                if (!empty($body['password'])) {
                    $u['password_hash'] = password_hash($body['password'], PASSWORD_BCRYPT);
                }
                $found = true; break;
            }
        }
        unset($u);
        if (!$found) { http_response_code(404); exit(json_encode(['error' => 'Usuario no encontrado'])); }
        $data['users'] = $users;
        if (!_write_json_file($file, $data)) {
            http_response_code(500);
            exit(json_encode(['error' => 'No se pudo escribir users.json']));
        }
        echo json_encode(['ok' => true]);
        return;
    }

    if ($op === 'delete') {
        $id = isset($_GET['id']) ? $_GET['id'] : '';
        // Protección: no podés eliminarte a vos mismo (te dejarías sin acceso).
        if (isset($current['u']) && strcasecmp($current['u'], $id) === 0) {
            http_response_code(400);
            exit(json_encode(['error' => 'No podés eliminar tu propio usuario']));
        }
        $countBefore = count($users);
        $users = array_values(array_filter($users, function($u) use ($id) {
            return !isset($u['username']) || strcasecmp($u['username'], $id) !== 0;
        }));
        if (count($users) === $countBefore) {
            http_response_code(404);
            exit(json_encode(['error' => 'Usuario no encontrado']));
        }
        // Asegurar que queda al menos un admin después del delete
        $admins = array_filter($users, function($u) { return ($u['role'] ?? 'user') === 'admin'; });
        if (count($admins) === 0) {
            http_response_code(400);
            exit(json_encode(['error' => 'Debe quedar al menos un admin']));
        }
        $data['users'] = $users;
        if (!_write_json_file($file, $data)) {
            http_response_code(500);
            exit(json_encode(['error' => 'No se pudo escribir users.json']));
        }
        echo json_encode(['ok' => true]);
        return;
    }

    http_response_code(400);
    echo json_encode(['error' => 'Operación inválida']);
}

function admin_lists($op) {
    $file = __DIR__ . '/private/lists.json';
    $data = _read_json_file($file, 'lists');
    $lists = $data['lists'];
    header('Content-Type: application/json; charset=utf-8');

    if ($op === 'list') {
        echo json_encode(['lists' => $lists]);
        return;
    }

    $body = read_json_body() ?: [];

    if ($op === 'create') {
        $id   = trim($body['id'] ?? '');
        $name = trim($body['name'] ?? '');
        $url  = trim($body['url'] ?? '');
        if ($id === '' || $name === '' || $url === '') {
            http_response_code(400);
            exit(json_encode(['error' => 'id, name y url son obligatorios']));
        }
        if (!preg_match('/^[a-zA-Z0-9_-]+$/', $id)) {
            http_response_code(400);
            exit(json_encode(['error' => 'id solo puede tener letras, números, _ y -']));
        }
        foreach ($lists as $l) {
            if (isset($l['id']) && strcasecmp($l['id'], $id) === 0) {
                http_response_code(409);
                exit(json_encode(['error' => 'Ya existe una lista con ese id']));
            }
        }
        $lists[] = [
            'id'          => $id,
            'name'        => $name,
            'url'         => $url,
            'description' => trim($body['description'] ?? ''),
        ];
        $data['lists'] = $lists;
        if (!_write_json_file($file, $data)) {
            http_response_code(500);
            exit(json_encode(['error' => 'No se pudo escribir lists.json']));
        }
        echo json_encode(['ok' => true]);
        return;
    }

    if ($op === 'update') {
        $id = isset($_GET['id']) ? $_GET['id'] : '';
        $found = false;
        foreach ($lists as &$l) {
            if (isset($l['id']) && strcasecmp($l['id'], $id) === 0) {
                if (isset($body['name'])) $l['name'] = trim($body['name']);
                if (isset($body['url']))  $l['url']  = trim($body['url']);
                if (isset($body['description'])) $l['description'] = trim($body['description']);
                $found = true; break;
            }
        }
        unset($l);
        if (!$found) { http_response_code(404); exit(json_encode(['error' => 'Lista no encontrada'])); }
        $data['lists'] = $lists;
        if (!_write_json_file($file, $data)) {
            http_response_code(500);
            exit(json_encode(['error' => 'No se pudo escribir lists.json']));
        }
        echo json_encode(['ok' => true]);
        return;
    }

    if ($op === 'delete') {
        $id = isset($_GET['id']) ? $_GET['id'] : '';
        $countBefore = count($lists);
        $lists = array_values(array_filter($lists, function($l) use ($id) {
            return !isset($l['id']) || strcasecmp($l['id'], $id) !== 0;
        }));
        if (count($lists) === $countBefore) {
            http_response_code(404);
            exit(json_encode(['error' => 'Lista no encontrada']));
        }
        $data['lists'] = $lists;
        if (!_write_json_file($file, $data)) {
            http_response_code(500);
            exit(json_encode(['error' => 'No se pudo escribir lists.json']));
        }
        echo json_encode(['ok' => true]);
        return;
    }

    http_response_code(400);
    echo json_encode(['error' => 'Operación inválida']);
}

// ─── Acción: teststream ─────────────────────────────────────────────────
// Diagnóstico rápido: prueba una URL desde el server con varios UAs y
// devuelve qué pasó. Usado por el front cuando un canal falla, para
// mostrarle al user si es geo-block, server caído, etc.
if ($action === 'teststream') {
    require_token();
    $encoded = isset($_GET['u']) ? $_GET['u'] : '';
    if (!$encoded) { http_response_code(400); exit('Missing u'); }
    $url = b64url_decode($encoded);
    if (!$url || !preg_match('#^https?://#i', $url)) {
        http_response_code(400);
        exit('Bad URL');
    }

    $uas = ['VLC/3.0.20', 'Mozilla/5.0', 'Kodi/19.5', 'Lavf/58.76.100'];
    $results = [];
    $best = null;
    foreach ($uas as $ua) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_USERAGENT      => $ua,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_NOBODY         => false,  // queremos algunos bytes
            CURLOPT_RANGE          => '0-2047',
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $err  = curl_error($ch);
        $time = curl_getinfo($ch, CURLINFO_TOTAL_TIME);
        curl_close($ch);
        $r = [
            'ua' => $ua,
            'http_code' => $code,
            'content_type' => $type,
            'time_s' => round($time, 2),
            'error' => $err ?: null,
            'looks_like_m3u8' => $body && strpos($body, '#EXTM3U') !== false,
        ];
        $results[] = $r;
        if ($code >= 200 && $code < 400 && $body !== false && !$best) $best = $r;
    }

    header('Content-Type: application/json');
    echo json_encode([
        'url' => $url,
        'works' => $best !== null,
        'best' => $best,
        'all_attempts' => $results,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

// ─── Acción: stream ─────────────────────────────────────────────────────
// Pass-through autenticado de cualquier URL. Imprescindible para reproducir
// streams HTTP en un sitio HTTPS (mixed content blocking del browser).
//
// Para HLS (.m3u8): reescribe las URLs internas del playlist (variantes,
// segmentos .ts, claves) para que también pasen por este proxy. Así el
// browser solo ve URLs same-origin sobre HTTPS.
if ($action === 'stream') {
    require_token();
    $encoded = isset($_GET['u']) ? $_GET['u'] : '';
    if (!$encoded) { http_response_code(400); exit('Missing u'); }
    $url = b64url_decode($encoded);
    if (!$url || !preg_match('#^https?://#i', $url)) {
        http_response_code(400);
        exit('Bad URL');
    }

    // Algunos servers IPTV son picky con el User-Agent y rechazan headers
    // genéricos. Probamos en orden los UAs más comunes que aceptan estos
    // streams. Si el primero falla con 401/403/406/429, probamos el siguiente.
    $uas = [
        'VLC/3.0.20 LibVLC/3.0.20',
        'Lavf/58.76.100',                                // ffmpeg
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Kodi/19.5 (Windows NT 10.0.19044; Win64; x64) App_Bitness/64 Version/19.5-Matrix',
        'IPTVSmarters/1.0',
    ];

    $body = false; $code = 0; $type = ''; $final = $url; $tried = [];
    foreach ($uas as $ua) {
        $ch = curl_init($url);
        // Pasamos también Range si el cliente lo envió (HLS segmentos lo usan).
        $extraHeaders = [];
        if (!empty($_SERVER['HTTP_RANGE'])) $extraHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_USERAGENT      => $ua,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_HEADER         => false,
            CURLOPT_HTTPHEADER     => $extraHeaders,
        ]);
        $body  = curl_exec($ch);
        $code  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $type  = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $final = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        $err   = curl_error($ch);
        curl_close($ch);
        $tried[] = ['ua' => substr($ua, 0, 30), 'code' => $code, 'err' => $err ?: null];
        // 200/206 (full / partial content) son OK. 4xx/5xx → reintentar con otro UA.
        if ($body !== false && $code > 0 && $code < 400) break;
        if ($code === 0 && $err && stripos($err, 'timeout') === false) break; // error de red persistente
    }

    if ($body === false || $code >= 400 || $code === 0) {
        http_response_code(502);
        header('Content-Type: application/json');
        // Mensaje legible para mostrar en el front. Incluye traza de UAs probados.
        exit(json_encode([
            'error' => 'Upstream failed',
            'http_code' => $code,
            'tried' => $tried,
            'hint' => $code === 0
                ? 'El server no respondió — probablemente está caído, o Bluehost (US) no tiene ruta a esa IP (geo-bloqueo).'
                : ($code === 403 || $code === 401 ? 'Acceso denegado por el server upstream — geo-block o whitelist de IPs.'
                : 'El server respondió con error HTTP ' . $code . '.'),
        ]));
    }

    // ¿Es un playlist M3U/HLS? Detectamos por content-type, extensión o magic.
    $is_m3u8 = (stripos((string)$type, 'mpegurl') !== false)
            || (stripos((string)$type, 'm3u') !== false)
            || preg_match('/\.m3u8?(\?|$)/i', $url)
            || (substr(ltrim($body), 0, 7) === '#EXTM3U');

    if ($is_m3u8) {
        $token = $_GET['token'];
        $proxy = './proxy.php?action=stream&token=' . urlencode($token) . '&u=';
        $body  = rewrite_m3u8($body, $final, $proxy);
        header('Content-Type: application/vnd.apple.mpegurl; charset=utf-8');
        header('Cache-Control: no-cache');
    } else {
        // Segmento .ts, .aac, .key, etc. → pass-through binario.
        header('Content-Type: ' . ($type ?: 'application/octet-stream'));
        header('Cache-Control: public, max-age=10');
    }
    http_response_code(200);
    echo $body;
    exit;
}

// Reescribe playlist HLS para que todas las URLs internas pasen por proxy.
// Maneja URLs absolutas, relativas con / inicial, y relativas al directorio.
// También procesa el atributo URI="..." que aparece en EXT-X-KEY y EXT-X-MAP.
function rewrite_m3u8($body, $base_url, $proxy_prefix) {
    // Normaliza saltos de línea
    $lines = preg_split('/\r?\n/', $body);
    $out = [];
    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '') { $out[] = ''; continue; }
        if ($trimmed[0] === '#') {
            // Reescribe URI="..." si aparece (claves de cifrado, MAP)
            $line = preg_replace_callback('/URI="([^"]+)"/', function($m) use ($base_url, $proxy_prefix) {
                $abs = absolute_url($m[1], $base_url);
                return 'URI="' . $proxy_prefix . url_b64url_encode($abs) . '"';
            }, $line);
            $out[] = $line;
        } else {
            $abs = absolute_url($trimmed, $base_url);
            $out[] = $proxy_prefix . url_b64url_encode($abs);
        }
    }
    return implode("\n", $out);
}

function url_b64url_encode($s) {
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

function absolute_url($url, $base) {
    if (preg_match('#^https?://#i', $url)) return $url;
    $p = parse_url($base);
    if (!$p || !isset($p['scheme'], $p['host'])) return $url;
    $origin = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if ($url !== '' && $url[0] === '/') return $origin . $url;
    $base_path = isset($p['path']) ? $p['path'] : '/';
    $base_dir  = rtrim(substr($base_path, 0, strrpos($base_path, '/') + 1), '/');
    return $origin . $base_dir . '/' . $url;
}

// ─── Acción: m3u_raw ────────────────────────────────────────────────────
// Devuelve el .m3u original (no parseado, plain text). Usado por:
//   1. El frontend para descargar la lista al disco.
//   2. VLC cuando se abre vía vlc://https://guia.dar2.cl/proxy.php?action=m3u_raw...
// Requiere token en query (no Authorization header) para que VLC pueda
// traerlo sin auth interactiva.
if ($action === 'm3u_raw') {
    require_token();
    $id = isset($_GET['id']) ? $_GET['id'] : '';
    if (!$id) { http_response_code(400); exit('Missing id'); }
    $listsFile = __DIR__ . '/private/lists.json';
    $data = is_file($listsFile) ? json_decode(file_get_contents($listsFile), true) : ['lists'=>[]];
    $list = null;
    if (isset($data['lists']) && is_array($data['lists'])) {
        foreach ($data['lists'] as $l) {
            if (isset($l['id']) && $l['id'] === $id) { $list = $l; break; }
        }
    }
    if (!$list) { http_response_code(404); exit('List not found'); }
    $body = fetch_url($list['url']);
    if ($body === null) { http_response_code(502); exit('Upstream fetch failed'); }
    $safe = preg_replace('/[^a-zA-Z0-9_-]+/', '_', $list['id']) . '-' . date('Ymd');
    header('Content-Type: application/vnd.apple.mpegurl; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $safe . '.m3u"');
    header('Cache-Control: no-store');
    echo $body;
    exit;
}

// ─── Acción: m3u ────────────────────────────────────────────────────────
if ($action === 'm3u') {
    require_token();
    $id = isset($_GET['id']) ? $_GET['id'] : '';
    if (!$id) { http_response_code(400); exit('Missing id'); }
    $listsFile = __DIR__ . '/private/lists.json';
    $data = is_file($listsFile) ? json_decode(file_get_contents($listsFile), true) : ['lists'=>[]];
    $list = null;
    if (isset($data['lists']) && is_array($data['lists'])) {
        foreach ($data['lists'] as $l) {
            if (isset($l['id']) && $l['id'] === $id) { $list = $l; break; }
        }
    }
    if (!$list) { http_response_code(404); exit('List not found'); }

    $body = fetch_url($list['url']);
    if ($body === null) { http_response_code(502); exit('Upstream fetch failed'); }

    $channels = parse_m3u($body);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    echo json_encode([
        'list'       => $list,
        'channels'   => $channels,
        'count'      => count($channels),
        'fetched_at' => time(),
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// ─── M3U parser ─────────────────────────────────────────────────────────
function parse_m3u($text) {
    if (substr($text, 0, 3) === "\xEF\xBB\xBF") $text = substr($text, 3);
    $lines = preg_split('/\r?\n/', $text);
    $channels = [];
    $current = null;
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (strpos($line, '#EXTINF:') === 0) {
            $meta = substr($line, 8);
            $commaIdx = strpos($meta, ',');
            if ($commaIdx === false) continue;
            $attrs = substr($meta, 0, $commaIdx);
            $name  = trim(substr($meta, $commaIdx + 1));
            $current = ['name' => $name];
            if (preg_match('/tvg-logo="([^"]*)"/', $attrs, $m)) $current['logo']    = $m[1];
            if (preg_match('/group-title="([^"]*)"/', $attrs, $m)) $current['group'] = $m[1];
            if (preg_match('/tvg-id="([^"]*)"/', $attrs, $m)) $current['tvgId']     = $m[1];
            if (preg_match('/tvg-name="([^"]*)"/', $attrs, $m)) $current['tvgName'] = $m[1];
        } else if ($line[0] !== '#') {
            if ($current) {
                $current['url'] = $line;
                $current['id']  = substr(md5($current['name'] . '|' . $line), 0, 10);
                $channels[] = $current;
                $current = null;
            }
        }
    }
    return $channels;
}

// ─── Fetch URL helper para listas privadas ──────────────────────────────
function fetch_url($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_USERAGENT      => 'VLC/3.0.20 LibVLC/3.0.20',
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_ENCODING       => '',
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return $body !== false ? $body : null;
}

// ─── Modo proxy CORS para RSS (comportamiento original) ─────────────────
$allowed = [
    'news.google.com',
    'www.emol.com',
    'www.latercera.com',
    'www.t13.cl',
    'www.biobiochile.cl',
];

$encoded = isset($_GET['u']) ? $_GET['u'] : '';
if (!$encoded) {
    http_response_code(400);
    exit('Missing u parameter');
}

$url = base64_decode(strtr($encoded, '-_', '+/'), true);
if ($url === false || empty($url)) {
    http_response_code(400);
    exit('Invalid base64 in u');
}

$host = parse_url($url, PHP_URL_HOST);
if (!$host || !in_array($host, $allowed, true)) {
    http_response_code(403);
    exit('Host not allowed: ' . htmlspecialchars($host ?: '(none)'));
}

header('Cache-Control: public, max-age=600');

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_USERAGENT      => 'Mozilla/5.0 (compatible; GuiaRSS/1.0)',
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_ENCODING       => '',
]);
$body   = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$type   = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$err    = curl_error($ch);
curl_close($ch);

if ($body === false) {
    http_response_code(502);
    exit('Upstream fetch failed: ' . $err);
}

http_response_code($status ?: 200);
if ($type) header('Content-Type: ' . $type);
echo $body;
